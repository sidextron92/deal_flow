import { CartItemRaw, DiscountOverride, PriceData } from "@/lib/types";
import { fetchCartFromMySQL } from "./mysql";
import { fetchPricesForCart } from "./price-api";
import { calculateCart } from "./calculator";

export async function getCartWithDeal(
  phone: string,
  discountOverrides?: DiscountOverride[]
) {
  const cartItems: CartItemRaw[] = await fetchCartFromMySQL(phone);
  const prices: PriceData[] = await fetchPricesForCart(cartItems);

  const { items, summary } = calculateCart(
    cartItems,
    prices,
    discountOverrides
  );

  return {
    phone,
    items,
    summary,
  };
}
