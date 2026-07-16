import { CartItemRaw, DiscountOverride, PriceData } from "@/lib/types";
import { fetchCartExclusions, fetchCartFromMySQL } from "./mysql";
import { fetchPricesForCart } from "./price-api";
import { calculateCart } from "./calculator";

export async function getCartWithDeal(
  phone: string,
  sellerId: string,
  discountOverrides?: DiscountOverride[]
) {
  const [cartItems, excluded] = await Promise.all([
    fetchCartFromMySQL(phone, sellerId),
    fetchCartExclusions(phone, sellerId),
  ]);
  const prices: PriceData[] = await fetchPricesForCart(
    cartItems as CartItemRaw[]
  );

  const { items, summary } = calculateCart(
    cartItems,
    prices,
    discountOverrides
  );

  return {
    phone,
    items,
    summary,
    excluded,
  };
}
