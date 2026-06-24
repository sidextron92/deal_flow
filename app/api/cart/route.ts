import { NextRequest } from "next/server";
import { fetchCartFromMySQL } from "@/lib/services/mysql";
import { fetchPricesForCart } from "@/lib/services/price-api";
import { calculateCart } from "@/lib/services/calculator";
import { DiscountOverride } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const phone = request.nextUrl.searchParams.get("phone");

    if (!phone) {
      return Response.json({ error: "phone is required" }, { status: 400 });
    }

    const cartItems = await fetchCartFromMySQL(phone);
    const prices = await fetchPricesForCart(cartItems);
    const { items, summary } = calculateCart(cartItems, prices);

    return Response.json({ phone, items, summary });
  } catch (err) {
    console.error("[API /cart GET] Error:", err);
    return Response.json(
      {
        error: "Failed to fetch cart",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);

    if (!body || typeof body.phone !== "string") {
      return Response.json({ error: "phone is required" }, { status: 400 });
    }

    const { phone, quantities, discounts } = body as {
      phone: string;
      quantities?: { variantid: number; sizeid: number; setCount: number }[];
      discounts?: DiscountOverride[];
    };

    let cartItems = await fetchCartFromMySQL(phone);

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

    const { items, summary } = calculateCart(cartItems, prices, discounts);

    return Response.json({ phone, items, summary });
  } catch (err) {
    console.error("[API /cart POST] Error:", err);
    return Response.json(
      {
        error: "Failed to recalculate cart",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
