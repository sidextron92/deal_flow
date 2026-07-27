import { NextRequest } from "next/server";
import { fetchDiscountEligibleSkus } from "@/lib/services/discount-eligible-skus";
import {
  resolveSellerIdFromFos,
  resolveWarehouseIdFromSellerId,
} from "@/lib/services/mysql";
import { checkAuthKey, getFosId } from "@/lib/auth";

async function resolveWarehouse(
  request: NextRequest
): Promise<{ warehouseId: number } | { error: string }> {
  const override = process.env.SELLER_ID;
  if (override) {
    const warehouseId = await resolveWarehouseIdFromSellerId(override);
    if (!warehouseId) return { error: "no warehouse found for override seller" };
    return { warehouseId: Number(warehouseId) };
  }

  const fosId = getFosId(request);
  if (!fosId) return { error: "trader context missing" };

  const resolved = await resolveSellerIdFromFos(fosId);
  if (!resolved) return { error: "no seller found for this trader" };
  return { warehouseId: Number(resolved.warehouseId) };
}

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const unauthorized = checkAuthKey(request);
    if (unauthorized) return unauthorized;

    const pincode = request.nextUrl.searchParams.get("pincode");

    if (!pincode) {
      return Response.json({ error: "pincode is required" }, { status: 400 });
    }

    const resolved = await resolveWarehouse(request);
    if ("error" in resolved) {
      return Response.json({ error: resolved.error }, { status: 400 });
    }

    const items = await fetchDiscountEligibleSkus(resolved.warehouseId, pincode);
    return Response.json({ pincode, items });
  } catch (err) {
    console.error("[API /discount-eligible-skus GET] Error:", err);
    return Response.json(
      {
        error: "Failed to fetch discount eligible SKUs",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
