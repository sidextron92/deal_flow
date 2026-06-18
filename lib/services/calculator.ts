import {
  CalculatedCartItem,
  CartItemRaw,
  DealSummary,
  DiscountOverride,
  PriceData,
} from "@/lib/types";

// Placeholder business constraints. Adjust later when finalised.
const MIN_PROFIT_MARGIN_PCT = 5; // do not let post-discount margin fall below this
const MAX_ITEM_DISCOUNT_PCT = 25; // hard ceiling on any single item

function calculateItemMaxDiscountPct(item: CartItemRaw): number {
  // Placeholder rule engine. Replace with real business rules later.
  let pct = 5;

  if (item.CurrentInventory > 200) pct += 3;
  if (item.Ageing > 90) pct += 5;
  if (item.DaysFromLastOrder > 30) pct += 2;
  if (item.BrandType === "Private Label") pct += 3;

  return Math.min(pct, MAX_ITEM_DISCOUNT_PCT);
}

function clampItemDiscountByMargin(
  item: CartItemRaw & PriceData,
  desiredPct: number
): number {
  const pieces = item.setCount * item.lotSize;
  const totalValue = pieces * item.landingPrice;
  const lineValueExTax = pieces * item.landingPriceBeforeTax;
  const cost = pieces * item.purchasePriceWithoutTax;

  // Keep the cap aligned with the margin displayed in the UI.
  // We need: (ex-tax profit - discount) / totalValue >= MIN_PROFIT_MARGIN_PCT
  // Solve for max discount amount, then convert to pct of totalValue.
  const minProfit = (MIN_PROFIT_MARGIN_PCT / 100) * totalValue;
  const maxDiscountAmount = lineValueExTax - cost - minProfit;

  if (maxDiscountAmount <= 0) return 0;

  const marginCapPct = (maxDiscountAmount / totalValue) * 100;
  return Math.min(desiredPct, Math.max(0, marginCapPct));
}

function getDiscountOverride(
  variantid: number,
  sizeid: number,
  overrides?: DiscountOverride[]
): DiscountOverride | undefined {
  return overrides?.find(
    (o) => o.variantid === variantid && o.sizeid === sizeid
  );
}

export function calculateCart(
  cartItems: CartItemRaw[],
  prices: PriceData[],
  discountOverrides?: DiscountOverride[]
): { items: CalculatedCartItem[]; summary: DealSummary } {
  const items: CalculatedCartItem[] = [];
  let totalCartValue = 0;
  let totalProfit = 0;
  let totalRevenueWithTax = 0;
  let totalDiscountAmount = 0;

  for (let i = 0; i < cartItems.length; i++) {
    const raw = cartItems[i];
    const price = prices[i];

    if (!price) {
      console.warn(
        `[Calculator] Missing price for variant ${raw.variantid} size ${raw.sizeid}. Skipping item.`
      );
      continue;
    }

    const pieces = raw.setCount * raw.lotSize;
    const totalValue = pieces * price.landingPrice;
    const lineValueExTax = pieces * price.landingPriceBeforeTax;
    const cost = pieces * raw.purchasePriceWithoutTax;

    const profitAmount = lineValueExTax - cost;
    const profitMarginPct = totalValue > 0 ? (profitAmount / totalValue) * 100 : 0;

    const desiredDiscountPct = calculateItemMaxDiscountPct(raw);
    const maxDiscountPct = clampItemDiscountByMargin(
      { ...raw, ...price },
      desiredDiscountPct
    );
    const maxDiscountAmount = (maxDiscountPct / 100) * totalValue;

    const override = getDiscountOverride(raw.variantid, raw.sizeid, discountOverrides);

    let discountPct = override?.pct ?? maxDiscountPct;
    let discountAmount = override?.amount ?? (discountPct / 100) * totalValue;

    // Prefer amount if both are provided, then re-derive pct.
    if (override?.amount !== undefined) {
      discountAmount = Math.min(override.amount, maxDiscountAmount);
      discountPct = totalValue > 0 ? (discountAmount / totalValue) * 100 : 0;
    } else {
      discountPct = Math.min(discountPct, maxDiscountPct);
      discountAmount = (discountPct / 100) * totalValue;
    }

    const dealValue = totalValue - discountAmount;
    const effectivePriceWithTax = pieces > 0 ? dealValue / pieces : 0;
    const profitAfterDiscount = profitAmount - discountAmount;
    const marginAfterDiscountPct =
      totalValue > 0 ? (profitAfterDiscount / totalValue) * 100 : 0;

    items.push({
      ...raw,
      ...price,
      pieces,
      totalValue,
      profitAmount,
      profitMarginPct,
      maxDiscountPct,
      maxDiscountAmount,
      discountAmount,
      discountPct,
      effectivePriceWithTax,
      dealValue,
      profitAfterDiscount,
      marginAfterDiscountPct,
    });

    totalCartValue += totalValue;
    totalProfit += profitAmount;
    totalRevenueWithTax += totalValue;
    totalDiscountAmount += discountAmount;
  }

  const overallMarginPct =
    totalRevenueWithTax > 0 ? (totalProfit / totalRevenueWithTax) * 100 : 0;

  const maxCartDiscountPct =
    totalCartValue > 0 ? (totalDiscountAmount / totalCartValue) * 100 : 0;

  const finalDealPrice = totalCartValue - totalDiscountAmount;
  const profitAfterDiscount = totalProfit - totalDiscountAmount;
  const marginAfterDiscountPct =
    totalRevenueWithTax > 0
      ? (profitAfterDiscount / totalRevenueWithTax) * 100
      : 0;

  const summary: DealSummary = {
    totalCartValue,
    totalProfit,
    overallMarginPct,
    maxCartDiscountPct,
    maxCartDiscountAmount: totalDiscountAmount,
    finalDealPrice,
    profitAfterDiscount,
    marginAfterDiscountPct,
  };

  return { items, summary };
}
