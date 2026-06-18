export interface CartItemRaw {
  userid: string;
  sellerid: string;
  fmWarehouseid: string;
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
  SubCategory: string;
  GroupName: string;
  MainCategory: string;
  Brand: string;
  BrandType: string;
  DaysFromLastOrder: number;
  Ageing: number;
  CurrentInventory: number;
  pincode: string;
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

export interface CartResponse {
  phone: string;
  items: CalculatedCartItem[];
  summary: DealSummary;
}
