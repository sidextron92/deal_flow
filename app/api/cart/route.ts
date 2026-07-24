import { NextRequest } from "next/server";
import {
  fetchCartExclusions,
  fetchCartFromMySQL,
  resolveSellerIdFromFos,
  retailerExists,
} from "@/lib/services/mysql";
import { fetchPricesForCart } from "@/lib/services/price-api";
import { calculateCart } from "@/lib/services/calculator";
import {
  CalculatedCartItem,
  CartExclusions,
  DiscountOverride,
  EmptyReason,
} from "@/lib/types";
import { checkAuthKey, getFosId } from "@/lib/auth";

// Resolve the trader's seller: a local-dev SELLER_ID override wins, otherwise
// derive it from the (gateway-injected, un-spoofable) fosId via the DS mapping.
// Returns { sellerId } on success, or { error } describing why it couldn't.
async function resolveSeller(
  request: NextRequest
): Promise<{ sellerId: string } | { error: string }> {
  const override = process.env.SELLER_ID;
  if (override) return { sellerId: override };

  const fosId = getFosId(request);
  if (!fosId) return { error: "trader context missing" };

  const sellerId = await resolveSellerIdFromFos(fosId);
  if (!sellerId) return { error: "no seller found for this trader" };
  return { sellerId };
}

export const dynamic = "force-dynamic";

// When a cart has no deal-able items, say why. Only runs the extra lookup on the
// empty path, so the normal (populated) cart pays nothing.
async function computeEmptyReason(
  items: CalculatedCartItem[],
  excluded: CartExclusions,
  phone: string
): Promise<EmptyReason | null> {
  if (items.length > 0) return null;
  // Items exist but were all filtered out — the UI explains this via `excluded`.
  if (excluded.outOfStock + excluded.preOrder > 0) return null;
  return (await retailerExists(phone)) ? "no_deal_cart" : "unknown_retailer";
}

export async function GET(request: NextRequest) {
  try {
    const unauthorized = checkAuthKey(request);
    if (unauthorized) return unauthorized;

    const phone = request.nextUrl.searchParams.get("phone");

    if (!phone) {
      return Response.json({ error: "phone is required" }, { status: 400 });
    }

    const resolved = await resolveSeller(request);
    if ("error" in resolved) {
      return Response.json({ error: resolved.error }, { status: 400 });
    }
    const sellerId = resolved.sellerId;

    const [cartItems, excluded] = await Promise.all([
      fetchCartFromMySQL(phone, sellerId),
      fetchCartExclusions(phone, sellerId),
    ]);
    const prices = await fetchPricesForCart(cartItems);
    const { items, summary } = calculateCart(cartItems, prices);
    const emptyReason = await computeEmptyReason(items, excluded, phone);

    return Response.json({ phone, items, summary, excluded, emptyReason });
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

    const { phone, quantities, discounts } = body as {
      phone: string;
      quantities?: { variantid: number; sizeid: number; setCount: number }[];
      discounts?: DiscountOverride[];
    };

    const [initialCartItems, excluded] = await Promise.all([
      fetchCartFromMySQL(phone, sellerId),
      fetchCartExclusions(phone, sellerId),
    ]);
    let cartItems = initialCartItems;

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
    const emptyReason = await computeEmptyReason(items, excluded, phone);

    return Response.json({ phone, items, summary, excluded, emptyReason });
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
