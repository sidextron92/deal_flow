import { NextRequest } from "next/server";
import { RowDataPacket } from "mysql2";
import {
  fetchCartFromMySQL,
  resolveSellerIdFromFos,
  resolveWarehouseIdFromSellerId,
} from "@/lib/services/mysql";
import { fetchPricesForCart } from "@/lib/services/price-api";
import { calculateCart } from "@/lib/services/calculator";
import { DiscountOverride } from "@/lib/types";
import { checkAuthKey, getFosId } from "@/lib/auth";
import { getPool } from "@/lib/db";

async function resolveSeller(
  request: NextRequest
): Promise<{ sellerId: string; warehouseId: string } | { error: string }> {
  const override = process.env.SELLER_ID;
  if (override) {
    const warehouseId = await resolveWarehouseIdFromSellerId(override);
    if (!warehouseId) return { error: "no warehouse found for override seller" };
    return { sellerId: override, warehouseId };
  }

  const fosId = getFosId(request);
  if (!fosId) return { error: "trader context missing" };

  const resolved = await resolveSellerIdFromFos(fosId);
  if (!resolved) return { error: "no seller found for this trader" };
  return resolved;
}

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const unauthorized = checkAuthKey(request);
    if (unauthorized) return unauthorized;

    const body = await request.json().catch(() => null);

    if (!body || typeof body.phone !== "string") {
      return Response.json({ error: "phone is required" }, { status: 400 });
    }

    const resolved = await resolveSeller(request);
    if ("error" in resolved) {
      return Response.json({ error: resolved.error }, { status: 400 });
    }
    const sellerId = resolved.sellerId;

    const { phone, truckid, quantities, discounts, summary } = body as {
      phone: string;
      truckid?: number;
      quantities?: { variantid: number; sizeid: number; setCount: number }[];
      discounts?: DiscountOverride[];
      summary?: {
        cartLevelDiscountAmount: number;
        maxCartDiscountAmount: number;
        maxCartDiscountPct: number;
        finalDealPrice: number;
        marginAfterDiscountPct: number;
      };
    };

    let cartItems = await fetchCartFromMySQL(phone, sellerId);

    if (Array.isArray(quantities) && quantities.length > 0) {
      const quantityMap = new Map(
        quantities.map((q) => [`${q.variantid}|${q.sizeid}`, q.setCount])
      );
      cartItems = cartItems.map((item) => {
        const key = `${item.variantid}|${item.sizeid}`;
        const updatedSetCount = quantityMap.get(key);
        if (updatedSetCount !== undefined && updatedSetCount >= 0) {
          return { ...item, setCount: updatedSetCount };
        }
        return item;
      });
    }

    const prices = await fetchPricesForCart(cartItems);
    const { items: calculatedItems } = calculateCart(
      cartItems,
      prices,
      discounts
    );

    if (calculatedItems.length === 0) {
      return Response.json(
        { error: "No deal-able items to save" },
        { status: 400 }
      );
    }

    const truckItemsMeta = calculatedItems.map((item) => ({
      Variantid: item.variantid,
      SizeId: item.sizeid,
      Quantity: item.setCount,
      OriginalLandingPrice: item.landingPrice,
      Original_Margin: item.profitMarginPct,
      Eligible_Discount: item.maxDiscountPct,
      Discount_Value_Applied: item.discountAmount,
      Discount_Percentage_Applied: item.discountPct,
      FinalLandingPrice: item.effectivePriceWithTax,
      Final_Margin: item.marginAfterDiscountPct,
    }));

    // Explicit env override for local dev, mirroring the SELLER_ID pattern.
    const fosId = process.env.FOS_ID || getFosId(request);
    const createdBy = fosId ? Number(fosId) || null : null;
    if (!createdBy) {
      return Response.json(
        { error: "trader context missing — set FOS_ID in env for local dev" },
        { status: 400 }
      );
    }

    const pool = getPool();
    const targetTruckId = truckid ?? calculatedItems[0].truckid ?? null;

    const [result] = await pool.query(
      `INSERT INTO liquidation_deals (
        userId, truckid, sellerId, truck_items_meta,
        cart_discount_amount, total_discount_amount, total_discount_percent,
        final_truck_amount, final_truck_margin_percent, status,
        orderId, offerType, referenceId, offerAmount,
        createdBy, updatedBy
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        userId = VALUES(userId),
        sellerId = VALUES(sellerId),
        truck_items_meta = VALUES(truck_items_meta),
        cart_discount_amount = VALUES(cart_discount_amount),
        total_discount_amount = VALUES(total_discount_amount),
        total_discount_percent = VALUES(total_discount_percent),
        final_truck_amount = VALUES(final_truck_amount),
        final_truck_margin_percent = VALUES(final_truck_margin_percent),
        status = VALUES(status),
        updatedBy = VALUES(updatedBy)`,
      [
        calculatedItems[0].userid ?? null,
        targetTruckId,
        sellerId,
        JSON.stringify(truckItemsMeta),
        summary?.cartLevelDiscountAmount ?? 0,
        summary?.maxCartDiscountAmount ?? 0,
        summary?.maxCartDiscountPct ?? 0,
        summary?.finalDealPrice ?? 0,
        summary?.marginAfterDiscountPct ?? 0,
        1,
        null,
        null,
        null,
        null,
        createdBy,
        createdBy,
      ]
    );

    // Fetch the deal id reliably (works for both insert and update)
    const [[dealRow]] = await pool.query<RowDataPacket[]>(
      `SELECT id FROM liquidation_deals WHERE truckid = ? LIMIT 1`,
      [targetTruckId]
    );

    const isUpdate = (result as { affectedRows: number }).affectedRows === 2;

    return Response.json({
      success: true,
      dealId: dealRow?.id ?? null,
      action: isUpdate ? "updated" : "created",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : "";
    console.error("[API /deals POST] 500 Error:", message);
    if (stack) console.error("[API /deals POST] Stack:", stack);
    return Response.json(
      {
        error: "Failed to save deal",
        detail: message,
        stack: process.env.NODE_ENV === "development" ? stack : undefined,
      },
      { status: 500 }
    );
  }
}
