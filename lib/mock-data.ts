import { CartItemRaw, PriceData } from "./types";

export const MOCK_CART_DB: Record<string, CartItemRaw[]> = {
  "9876543210": [
    {
      userid: "USR_001",
      sellerid: "SEL_001",
      fmWarehouseid: "WH_001",
      productId: 1001,
      variantid: 2001,
      sizeid: 3001,
      setCount: 5,
      purchasePriceWithoutTax: 180,
      MRP: 299,
      retailerMargin: 15,
      lotSize: 6,
      ProductName: "Classic Cotton T-Shirt",
      colorname: "Navy Blue",
      sizetext: "M",
      imageurl: "https://via.placeholder.com/80",
      SubCategory: "T-Shirts",
      GroupName: "Casual Wear",
      MainCategory: "Apparel",
      Brand: "Urban Basics",
      BrandType: "Private Label",
      DaysFromLastOrder: 12,
      Ageing: 45,
      CurrentInventory: 240,
      pincode: "",
    },
    {
      userid: "USR_001",
      sellerid: "SEL_001",
      fmWarehouseid: "WH_001",
      productId: 1001,
      variantid: 2001,
      sizeid: 3002,
      setCount: 3,
      purchasePriceWithoutTax: 180,
      MRP: 299,
      retailerMargin: 15,
      lotSize: 6,
      ProductName: "Classic Cotton T-Shirt",
      colorname: "Navy Blue",
      sizetext: "L",
      imageurl: "https://via.placeholder.com/80",
      SubCategory: "T-Shirts",
      GroupName: "Casual Wear",
      MainCategory: "Apparel",
      Brand: "Urban Basics",
      BrandType: "Private Label",
      DaysFromLastOrder: 12,
      Ageing: 45,
      CurrentInventory: 180,
      pincode: "",
    },
    {
      userid: "USR_001",
      sellerid: "SEL_001",
      fmWarehouseid: "WH_002",
      productId: 1002,
      variantid: 2002,
      sizeid: 3003,
      setCount: 2,
      purchasePriceWithoutTax: 450,
      MRP: 799,
      retailerMargin: 20,
      lotSize: 4,
      ProductName: "Slim Fit Denim Jeans",
      colorname: "Dark Blue",
      sizetext: "32",
      imageurl: "https://via.placeholder.com/80",
      SubCategory: "Jeans",
      GroupName: "Bottom Wear",
      MainCategory: "Apparel",
      Brand: "Denim Co.",
      BrandType: "National",
      DaysFromLastOrder: 45,
      Ageing: 120,
      CurrentInventory: 35,
      pincode: "",
    },
  ],
};

export const MOCK_PRICE_DB: Record<string, PriceData> = {
  "2001|3001": {
    variantid: 2001,
    sizeid: 3001,
    landingPriceBeforeTax: 220,
    landingPrice: 240,
  },
  "2001|3002": {
    variantid: 2001,
    sizeid: 3002,
    landingPriceBeforeTax: 220,
    landingPrice: 240,
  },
  "2002|3003": {
    variantid: 2002,
    sizeid: 3003,
    landingPriceBeforeTax: 520,
    landingPrice: 560,
  },
};

export function getMockCartByPhone(phone: string): CartItemRaw[] {
  return MOCK_CART_DB[phone] ?? [];
}

export function getMockPrice(variantid: number, sizeid: number): PriceData | null {
  return MOCK_PRICE_DB[`${variantid}|${sizeid}`] ?? null;
}
