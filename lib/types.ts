export interface CartItemRaw {
  userid: string;
  sellerid: string;
  fmWarehouseid: string;
  truckid: number;
  productId: number;
  variantid: number;
  sizeid: number;
  setCount: number;
  purchasePriceWithoutTax: number;
  MRP: number;
  retailerMargin: number;
  lotSize: number;
  ProductName: string;
  colorname: string;
  sizetext: string;
  imageurl: string;
  CurrentInventory: number;
  pincode: string;
  eligibleDiscount: number;
}

export interface PriceData {
  variantid: number;
  sizeid: number;
  landingPriceBeforeTax: number;
  landingPrice: number;
  // additional fields can be added when the Price API contract is finalized
}

export interface DiscountOverride {
  variantid: number;
  sizeid: number;
  amount?: number;
  pct?: number;
}

export interface CalculatedCartItem extends CartItemRaw, PriceData {
  pieces: number;
  totalValue: number;
  profitAmount: number;
  profitMarginPct: number;
  maxDiscountPct: number;
  maxDiscountAmount: number;
  discountAmount: number;
  discountPct: number;
  effectivePriceWithTax: number;
  dealValue: number;
  profitAfterDiscount: number;
  marginAfterDiscountPct: number;
}

export interface DealSummary {
  totalCartValue: number;
  totalProfit: number;
  overallMarginPct: number;
  maxCartDiscountPct: number;
  maxCartDiscountAmount: number;
  finalDealPrice: number;
  profitAfterDiscount: number;
  marginAfterDiscountPct: number;
}

// Cart lines that exist for this phone+seller but were filtered out of the deal
// calculator: OnStock items with no sellable stock, and non-OnStock (pre-order)
// items. Lets the UI explain an empty/partial cart instead of showing a blank.
export interface CartExclusions {
  outOfStock: number;
  preOrder: number;
}

// Why a cart came back with zero deal-able items — lets the UI say exactly what
// happened instead of a blank "no items":
//   - "unknown_retailer": no retailer is registered with this phone number.
//   - "no_deal_cart":     the retailer exists but has no active cart under this
//                         trader's seller (not in their deal scope / nothing added).
//   - null:               items were found, or they exist but are all excluded
//                         (out of stock / pre-order) — described by `excluded`.
export type EmptyReason = "unknown_retailer" | "no_deal_cart";

export interface CartResponse {
  phone: string;
  items: CalculatedCartItem[];
  summary: DealSummary;
  excluded: CartExclusions;
  emptyReason: EmptyReason | null;
}

export interface DiscountEligibleSkuRaw {
  warehouseid: number;
  productId: number;
  variantid: number;
  sizeid: number;
  MRP: number;
  purchasePriceWithoutTax: number;
  retailerMargin: number;
  ProductName: string;
  colorname: string;
  sizetext: string;
  imageurl: string;
  CurrentInventory: number;
  eligibleDiscount: number;
  performanceData: string | null;
  categoryGroupName: string;
  mainCategoryName: string;
}

export interface DiscountEligibleSku extends DiscountEligibleSkuRaw, PriceData {
  retailMarginPct: number | null;
}
