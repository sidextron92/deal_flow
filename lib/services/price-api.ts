import { CartItemRaw, PriceData } from "@/lib/types";

const PRICE_API_URL =
  "https://api.bijnis.com/g/ss/price-engine/get-variant-price-detail-v2";
const PRICE_API_TOKEN = "k6w+9:x@UNi8";

type PriceApiDiscountInfo = {
  subtotal?: number;
  total?: number;
  size_sets?: Record<string, { subtotal?: number; total?: number }>;
};

type PriceApiVariantData = {
  discount_info_resp?: PriceApiDiscountInfo;
  finalPriceBeforTax?: number;
};

type PriceLookupItem = {
  variantid: number;
  sizeid: number;
  purchasePriceWithoutTax: number;
  MRP: number;
  pincode?: string;
};

export async function fetchPricesForItems(
  items: PriceLookupItem[],
  destinationPincode = items[0]?.pincode
): Promise<PriceData[]> {
  if (items.length === 0) return [];

  const variantIds = [...new Set(items.map((i) => i.variantid))];

  const res = await fetch(PRICE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Token-X": PRICE_API_TOKEN,
    },
    cache: "no-store",
    body: JSON.stringify({
      variantIds,
      destinationPincode,
      requestType: 3,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Price API error ${res.status}: ${text}`);
  }

  const json = await res.json();
  if (json.status !== 1) {
    throw new Error(
      `Price API returned status ${json.status}: ${json.message}`
    );
  }

  const data = json.data as Record<string, PriceApiVariantData>;

  return items.map((item) => {
    const variantData = data[String(item.variantid)];
    if (!variantData) {
      console.warn(
        `[PriceAPI] No price data for variant ${item.variantid}`
      );
      return {
        variantid: item.variantid,
        sizeid: item.sizeid,
        landingPriceBeforeTax: item.purchasePriceWithoutTax,
        landingPrice:
          item.MRP > 0 ? item.MRP : item.purchasePriceWithoutTax,
      };
    }

    const discountInfo = variantData.discount_info_resp || {};
    const sizePrice = discountInfo.size_sets?.[String(item.sizeid)];

    return {
      variantid: item.variantid,
      sizeid: item.sizeid,
      landingPriceBeforeTax:
        sizePrice?.subtotal ??
        discountInfo.subtotal ??
        variantData.finalPriceBeforTax ??
        0,
      landingPrice:
        sizePrice?.total ??
        discountInfo.total ??
        variantData.finalPriceBeforTax ??
        0,
    };
  });
}

export async function fetchPricesForCart(
  items: CartItemRaw[]
): Promise<PriceData[]> {
  return fetchPricesForItems(items);
}

// Backward-compatible wrapper for single-item calls
export async function fetchPriceFromAPI(
  variantid: number,
  sizeid: number,
  fallback?: { landingPriceBeforeTax: number; landingPrice: number }
): Promise<PriceData> {
  const dummyItem: CartItemRaw = {
    userid: "",
    sellerid: "",
    fmWarehouseid: "",
    productId: 0,
    variantid,
    sizeid,
    setCount: 1,
    purchasePriceWithoutTax: fallback?.landingPriceBeforeTax ?? 0,
    MRP: fallback?.landingPrice ?? 0,
    retailerMargin: 0,
    lotSize: 1,
    ProductName: "",
    colorname: "",
    sizetext: "",
    imageurl: "",
    CurrentInventory: 0,
    pincode: "",
    eligibleDiscount: 0,
  };

  const [price] = await fetchPricesForItems([dummyItem]);
  return price;
}
