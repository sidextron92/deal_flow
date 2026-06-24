"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import {
  CalculatedCartItem,
  CartResponse,
  DiscountEligibleSku,
  DiscountOverride,
} from "@/lib/types";

function formatCurrency(value: number): string {
  return `₹${value.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatPct(value: number): string {
  return `${value.toFixed(1)}%`;
}

function toKey(item: CalculatedCartItem): string {
  return `${item.variantid}|${item.sizeid}`;
}

function computeItemState(
  item: CalculatedCartItem,
  setCount: number,
  discountAmount: number
) {
  const pieces = setCount * item.lotSize;
  const totalValue = pieces * item.landingPrice;
  const maxAmount = (item.maxDiscountPct / 100) * totalValue;
  const clampedDiscount = Math.max(0, Math.min(discountAmount, maxAmount));
  const dealValue = totalValue - clampedDiscount;
  const effectivePriceWithTax = pieces > 0 ? dealValue / pieces : 0;
  const profitAmount =
    pieces * (item.landingPriceBeforeTax - item.purchasePriceWithoutTax);
  const profitMarginPct =
    totalValue > 0 ? (profitAmount / totalValue) * 100 : 0;
  const profitAfterDiscount = profitAmount - clampedDiscount;
  const marginAfterDiscountPct =
    totalValue > 0 ? (profitAfterDiscount / totalValue) * 100 : 0;

  return {
    pieces,
    totalValue,
    maxAmount,
    clampedDiscount,
    dealValue,
    effectivePriceWithTax,
    profitAmount,
    profitMarginPct,
    profitAfterDiscount,
    marginAfterDiscountPct,
  };
}

export default function Home() {
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<CartResponse | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [discounts, setDiscounts] = useState<
    Record<string, { amount: number; pct: number }>
  >({});
  const [baselineDiscounts, setBaselineDiscounts] = useState<
    Record<string, { amount: number; pct: number }>
  >({});
  const [cartLevelDiscount, setCartLevelDiscount] = useState(0);
  const [isDiscountSheetOpen, setIsDiscountSheetOpen] = useState(false);
  const [discountSkus, setDiscountSkus] = useState<DiscountEligibleSku[]>([]);
  const [discountSkuPincode, setDiscountSkuPincode] = useState("");
  const [discountSkuLoading, setDiscountSkuLoading] = useState(false);
  const [discountSkuError, setDiscountSkuError] = useState<string | null>(null);
  const [discountSkuSearch, setDiscountSkuSearch] = useState("");
  const [discountSkuCategory, setDiscountSkuCategory] = useState("all");
  const [isDiscountCategoryOpen, setIsDiscountCategoryOpen] = useState(false);
  const [discountCategorySearch, setDiscountCategorySearch] = useState("");

  const phoneDigits = useMemo(() => phone.replace(/\D/g, ""), [phone]);
  const isValidPhone = phoneDigits.length === 10;
  const cartPincode = data?.items.find((item) => item.pincode)?.pincode ?? "";
  const showDiscountEligibleCta = Boolean(cartPincode);

  const loadCart = useCallback(async (phoneNumber: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/cart?phone=${phoneNumber}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load cart");
      setData(json);
      const qtyMap: Record<string, number> = {};
      const discMap: Record<string, { amount: number; pct: number }> = {};
      const baselineDiscMap: Record<string, { amount: number; pct: number }> = {};
      json.items.forEach((item: CalculatedCartItem) => {
        const key = toKey(item);
        qtyMap[key] = item.setCount;
        discMap[key] = { amount: 0, pct: 0 };
        baselineDiscMap[key] = { amount: 0, pct: 0 };
      });
      setQuantities(qtyMap);
      setDiscounts(discMap);
      setBaselineDiscounts(baselineDiscMap);
      setCartLevelDiscount(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setData(null);
      setQuantities({});
      setDiscounts({});
      setBaselineDiscounts({});
      setCartLevelDiscount(0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isValidPhone) return;
    const timer = setTimeout(() => {
      loadCart(phoneDigits);
    }, 400);
    return () => clearTimeout(timer);
  }, [phoneDigits, isValidPhone, loadCart]);

  async function openDiscountEligibleSheet() {
    if (!cartPincode) return;
    setIsDiscountSheetOpen(true);
    setDiscountSkuSearch("");
    setDiscountSkuCategory("all");
    setDiscountCategorySearch("");
    setIsDiscountCategoryOpen(false);

    if (discountSkus.length > 0 && discountSkuPincode === cartPincode) return;

    setDiscountSkuLoading(true);
    setDiscountSkuError(null);
    try {
      const res = await fetch(
        `/api/discount-eligible-skus?pincode=${encodeURIComponent(cartPincode)}`
      );
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || "Failed to load eligible SKUs");
      }
      setDiscountSkus(json.items ?? []);
      setDiscountSkuPincode(cartPincode);
    } catch (err) {
      setDiscountSkuError(err instanceof Error ? err.message : "Unknown error");
      setDiscountSkus([]);
    } finally {
      setDiscountSkuLoading(false);
    }
  }

  async function recalculateDeal() {
    if (!data) return;
    setLoading(true);
    setError(null);
    try {
      let remainingCartDiscount = localSummary?.cartLevelDiscountAmount ?? 0;
      const payload = {
        phone: data.phone,
        quantities: data.items.map((item) => {
          const key = toKey(item);
          return {
            variantid: item.variantid,
            sizeid: item.sizeid,
            setCount: quantities[key] ?? item.setCount,
          };
        }),
        discounts: data.items.map((item): DiscountOverride => {
          const key = toKey(item);
          const setCount = quantities[key] ?? item.setCount;
          const baseAmount = discounts[key]?.amount ?? 0;
          const state = computeItemState(item, setCount, baseAmount);
          const extraAmount = Math.min(
            Math.max(0, state.maxAmount - state.clampedDiscount),
            remainingCartDiscount
          );
          remainingCartDiscount -= extraAmount;
          return {
            variantid: item.variantid,
            sizeid: item.sizeid,
            amount: state.clampedDiscount + extraAmount,
          };
        }),
      };
      const res = await fetch("/api/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to recalculate");
      setData(json);
      const qtyMap: Record<string, number> = {};
      const discMap: Record<string, { amount: number; pct: number }> = {};
      json.items.forEach((item: CalculatedCartItem) => {
        const key = toKey(item);
        qtyMap[key] = item.setCount;
        discMap[key] = { amount: item.discountAmount, pct: item.discountPct };
      });
      setQuantities(qtyMap);
      setDiscounts(discMap);
      setBaselineDiscounts(discMap);
      setCartLevelDiscount(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  function updateQuantity(key: string, delta: number, maxStock: number) {
    setQuantities((prev) => {
      const current = prev[key] ?? 0;
      const next = Math.max(0, Math.min(current + delta, maxStock));
      return { ...prev, [key]: next };
    });
  }

  function setQuantity(key: string, rawValue: string, maxStock: number) {
    const value = Number(rawValue);
    const next = Number.isNaN(value) ? 0 : Math.max(0, Math.min(value, maxStock));
    setQuantities((prev) => ({ ...prev, [key]: next }));
  }

  function updateDiscountAmount(key: string, rawValue: string) {
    const item = data?.items.find((i) => toKey(i) === key);
    if (!item) return;
    const setCount = quantities[key] ?? item.setCount;
    const { totalValue, maxAmount, pieces } = computeItemState(
      item,
      setCount,
      discounts[key]?.amount ?? 0
    );
    let perUnitAmount = Number(rawValue);
    if (Number.isNaN(perUnitAmount)) perUnitAmount = 0;
    const perUnitMax = pieces > 0 ? maxAmount / pieces : 0;
    perUnitAmount = Math.max(0, Math.min(perUnitAmount, perUnitMax));
    const amount = perUnitAmount * pieces;
    const pct = totalValue > 0 ? (amount / totalValue) * 100 : 0;
    setDiscounts((prev) => ({ ...prev, [key]: { amount, pct } }));
  }

  function updateDiscountPct(key: string, rawValue: string) {
    const item = data?.items.find((i) => toKey(i) === key);
    if (!item) return;
    const setCount = quantities[key] ?? item.setCount;
    const { totalValue } = computeItemState(
      item,
      setCount,
      discounts[key]?.amount ?? 0
    );
    let pct = Number(rawValue);
    if (Number.isNaN(pct)) pct = 0;
    pct = Math.max(0, Math.min(pct, item.maxDiscountPct));
    const amount = (pct / 100) * totalValue;
    setDiscounts((prev) => ({ ...prev, [key]: { amount, pct } }));
  }

  function resetDiscount(key: string) {
    const item = data?.items.find((i) => toKey(i) === key);
    if (!item) return;
    const setCount = quantities[key] ?? item.setCount;
    const { maxAmount } = computeItemState(item, setCount, item.discountAmount);
    setDiscounts((prev) => ({
      ...prev,
      [key]: { amount: maxAmount, pct: item.maxDiscountPct },
    }));
  }

  function clearDiscount(key: string) {
    setDiscounts((prev) => ({
      ...prev,
      [key]: { amount: 0, pct: 0 },
    }));
  }

  function handlePhoneChange(value: string) {
    setPhone(value);
    if (value.replace(/\D/g, "").length !== 10) {
      setData(null);
      setQuantities({});
      setDiscounts({});
      setBaselineDiscounts({});
      setCartLevelDiscount(0);
      setError(null);
    }
  }

  function updateCartLevelDiscount(rawValue: string) {
    const value = Number(rawValue);
    const next = Number.isNaN(value) ? 0 : value;
    setCartLevelDiscount(
      Math.max(0, Math.min(next, localSummary?.cartLevelDiscountCap ?? 0))
    );
  }

  const localSummary = (() => {
    if (!data) return null;
    let totalCartValue = 0;
    let totalProfit = 0;
    let itemDiscountAmount = 0;
    let totalMaxAllowedDiscount = 0;
    data.items.forEach((item) => {
      const key = toKey(item);
      const setCount = quantities[key] ?? item.setCount;
      const discount = discounts[key] ?? {
        amount: 0,
        pct: 0,
      };
      const state = computeItemState(item, setCount, discount.amount);
      totalCartValue += state.totalValue;
      totalProfit += state.profitAmount;
      itemDiscountAmount += state.clampedDiscount;
      totalMaxAllowedDiscount += state.maxAmount;
    });
    const cartLevelDiscountCap = Math.max(
      0,
      totalMaxAllowedDiscount - itemDiscountAmount
    );
    const cartLevelDiscountAmount = Math.max(
      0,
      Math.min(cartLevelDiscount, cartLevelDiscountCap)
    );
    const totalDiscount = itemDiscountAmount + cartLevelDiscountAmount;
    const finalDealPrice = totalCartValue - totalDiscount;
    return {
      totalCartValue,
      totalProfit,
      overallMarginPct:
        totalCartValue > 0 ? (totalProfit / totalCartValue) * 100 : 0,
      maxCartDiscountAmount: totalDiscount,
      maxCartDiscountPct:
        totalCartValue > 0 ? (totalDiscount / totalCartValue) * 100 : 0,
      finalDealPrice,
      profitAfterDiscount: totalProfit - totalDiscount,
      marginAfterDiscountPct:
        totalCartValue > 0
          ? ((totalProfit - totalDiscount) / totalCartValue) * 100
          : 0,
      itemDiscountAmount,
      cartLevelDiscountCap,
      cartLevelDiscountAmount,
    };
  })();

  const hasChanges = (() => {
    if (!data) return false;
    return data.items.some((item) => {
      const key = toKey(item);
      const q = quantities[key] ?? item.setCount;
      const d = discounts[key] ?? {
        amount: 0,
        pct: 0,
      };
      const baseline = baselineDiscounts[key] ?? {
        amount: 0,
        pct: 0,
      };
      return (
        q !== item.setCount ||
        Math.round(d.amount) !== Math.round(baseline.amount) ||
        Number(d.pct.toFixed(2)) !== Number(baseline.pct.toFixed(2)) ||
        (localSummary?.cartLevelDiscountAmount ?? 0) > 0
      );
    });
  })();

  const discountSkuCategoryOptions = Array.from(
    new Set(
      discountSkus.map(
        (item) => `${item.mainCategoryName} × ${item.categoryGroupName}`
      )
    )
  ).sort();
  const filteredDiscountSkuCategoryOptions = discountSkuCategoryOptions.filter(
    (category) =>
      category.toLowerCase().includes(discountCategorySearch.trim().toLowerCase())
  );

  const normalizedDiscountSkuSearch = discountSkuSearch.trim().toLowerCase();
  const filteredDiscountSkus = discountSkus.filter((item) => {
    const category = `${item.mainCategoryName} × ${item.categoryGroupName}`;
    const matchesCategory =
      discountSkuCategory === "all" || category === discountSkuCategory;
    const matchesSearch =
      normalizedDiscountSkuSearch.length === 0 ||
      [
        item.ProductName,
        item.colorname,
        item.sizetext,
        item.mainCategoryName,
        item.categoryGroupName,
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedDiscountSkuSearch);

    return matchesCategory && matchesSearch;
  });

  return (
    <div className="min-h-screen bg-[#f6f3ee] pb-40 text-zinc-950">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-black/5 bg-[#f6f3ee]/90 px-4 py-4 shadow-sm shadow-black/5 backdrop-blur-xl sm:px-6">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-amber-700">
              Deal Flow
            </p>
            <h1 className="mt-1 text-xl font-black tracking-tight text-zinc-950 sm:text-2xl">
              Best Deal Calculator
            </h1>
          </div>
          {showDiscountEligibleCta && (
            <button
              type="button"
              onClick={openDiscountEligibleSheet}
              className="rounded-2xl bg-amber-500 px-4 py-2.5 text-sm font-black text-zinc-950 shadow-lg shadow-amber-500/20 ring-1 ring-amber-300 transition active:scale-[0.98] hover:bg-amber-400"
            >
              Discount Eligible
            </button>
          )}
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-5 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        {/* Phone Input */}
        <section className="rounded-3xl border border-white/70 bg-white/85 p-5 shadow-[0_20px_70px_rgba(45,35,20,0.08)] ring-1 ring-black/5 backdrop-blur lg:col-span-2">
          <label
            htmlFor="phone"
            className="text-sm font-bold text-zinc-800"
          >
            Customer Phone Number
          </label>
          <p className="mt-1 text-sm text-zinc-500 sm:hidden">
            Enter a 10-digit phone number to fetch the cart.
          </p>
          <input
            id="phone"
            type="tel"
            inputMode="numeric"
            autoComplete="off"
            value={phone}
            onChange={(e) => handlePhoneChange(e.target.value)}
            placeholder="9876543210"
            className="mt-3 w-full rounded-2xl border border-zinc-200 bg-zinc-50/80 px-4 py-3.5 text-lg font-bold tracking-wide text-zinc-950 outline-none transition placeholder:font-medium placeholder:text-zinc-400 focus:border-amber-600 focus:bg-white focus:ring-4 focus:ring-amber-600/10"
          />
          {phoneDigits.length > 0 && !isValidPhone && (
            <p className="mt-2 rounded-full bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800 ring-1 ring-amber-200/70">
              Enter a valid 10-digit phone number.
            </p>
          )}
        </section>

        {loading && (
          <div className="rounded-3xl border border-white/70 bg-white/85 p-10 text-center text-sm font-semibold text-zinc-500 shadow-sm ring-1 ring-black/5 lg:col-span-2">
            Loading cart...
          </div>
        )}

        {error && (
          <div className="rounded-2xl bg-red-50 p-4 text-sm font-semibold text-red-700 ring-1 ring-red-200 lg:col-span-2">
            {error}
          </div>
        )}

        {data && !loading && (
          <>
            {data.items.length === 0 ? (
              <div className="rounded-3xl border border-white/70 bg-white/85 p-10 text-center text-sm font-semibold text-zinc-500 shadow-sm ring-1 ring-black/5 lg:col-span-2">
                No cart items found for this phone number.
              </div>
            ) : (
              <>
                {/* Cart Items */}
                <section className="space-y-3">
                  <h2 className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.22em] text-zinc-500">
                    <span className="h-px w-6 bg-zinc-300" />
                    Cart Items ({data.items.length})
                  </h2>
                  {data.items.map((item) => {
                    const key = toKey(item);
                    const setCount = quantities[key] ?? item.setCount;
                    const discount = discounts[key] ?? {
                      amount: 0,
                      pct: 0,
                    };
                    const state = computeItemState(
                      item,
                      setCount,
                      discount.amount
                    );

                    return (
                      <article
                        key={key}
                        className="overflow-hidden rounded-[1.65rem] border border-white/70 bg-white shadow-[0_16px_48px_rgba(45,35,20,0.07)] ring-1 ring-black/5"
                      >
                        {/* Product header */}
                        <div className="flex items-center gap-3 p-3 sm:p-4">
                          <div className="relative h-20 w-20 flex-shrink-0 overflow-hidden rounded-2xl bg-zinc-100 ring-1 ring-black/5 sm:h-24 sm:w-24">
                            {item.imageurl ? (
                              <Image
                                src={item.imageurl}
                                alt={item.ProductName}
                                fill
                                className="object-cover"
                                unoptimized
                              />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center text-xs text-zinc-400">
                                No img
                              </div>
                            )}
                          </div>

                          <div className="min-w-0 flex-1">
                            <p className="text-base font-black leading-5 text-zinc-950">
                              {item.ProductName}
                            </p>
                            <p className="mt-0.5 text-xs leading-5 text-zinc-500 sm:text-sm">
                              {item.colorname}
                            </p>
                            <p className="text-xs leading-4 text-zinc-500 sm:text-sm">
                              {item.sizetext}
                            </p>
                            <div className="mt-2 inline-flex items-center rounded-full bg-amber-50 px-3 py-1 text-xs font-bold text-amber-800 ring-1 ring-amber-200/70">
                              Set Size: {item.lotSize} pcs
                            </div>
                          </div>

                          {/* Quantity Stepper */}
                          <div className="flex flex-shrink-0 flex-col items-center gap-1">
                            <div className="flex items-center gap-1.5 rounded-2xl bg-zinc-50 p-1.5 ring-1 ring-zinc-200/70">
                              <button
                                type="button"
                                aria-label="Decrease quantity"
                                onClick={() =>
                                  updateQuantity(key, -1, item.CurrentInventory)
                                }
                                className="flex h-8 w-8 items-center justify-center rounded-xl bg-white text-lg font-black text-zinc-950 shadow-sm ring-1 ring-zinc-200 transition active:scale-95 active:bg-zinc-100"
                              >
                                −
                              </button>
                              <input
                                type="number"
                                inputMode="numeric"
                                min={0}
                                max={item.CurrentInventory}
                                value={setCount}
                                onChange={(e) =>
                                  setQuantity(
                                    key,
                                    e.target.value,
                                    item.CurrentInventory
                                  )
                                }
                                className="h-8 w-12 appearance-none rounded-xl border border-zinc-200 bg-white px-0 py-0 text-center text-base font-black leading-8 text-zinc-950 outline-none transition focus:border-amber-600 focus:ring-4 focus:ring-amber-600/10"
                              />
                              <button
                                type="button"
                                aria-label="Increase quantity"
                                onClick={() =>
                                  updateQuantity(key, 1, item.CurrentInventory)
                                }
                                disabled={setCount >= item.CurrentInventory}
                                className="flex h-8 w-8 items-center justify-center rounded-xl bg-zinc-950 text-lg font-black text-white shadow-sm transition active:scale-95 active:bg-zinc-800 disabled:bg-zinc-200 disabled:text-zinc-400"
                              >
                                +
                              </button>
                            </div>
                            <span className="text-center text-[11px] font-medium text-zinc-500">
                              Max stock: {item.CurrentInventory} sets
                            </span>
                          </div>
                        </div>

                        {/* Pricing block */}
                        <div className="m-3 space-y-2 rounded-2xl bg-[#fbfaf7] p-3 text-sm ring-1 ring-zinc-200/70 sm:m-4">
                          <PriceRow
                            label="Landing Price (incl. tax)"
                            unitPrice={item.landingPrice}
                            pieces={state.pieces}
                            total={state.totalValue}
                          />

                          <div className="flex items-center justify-between">
                            <span className="text-zinc-500">
                              Bijnis Margin / unit
                            </span>
                            <span
                              className={`font-semibold ${
                                state.profitMarginPct >= 15
                                  ? "text-green-700"
                                  : state.profitMarginPct >= 5
                                  ? "text-amber-700"
                                  : "text-red-700"
                              }`}
                            >
                              {formatCurrency(
                                state.pieces > 0
                                  ? state.profitAmount / state.pieces
                                  : 0
                              )}
                              <span className="ml-1 text-xs">
                                ({formatPct(state.profitMarginPct)})
                              </span>
                            </span>
                          </div>

                          {/* Editable Max Discount */}
                          <div className="rounded-2xl bg-white p-3 ring-1 ring-zinc-200/80">
                            <div className="flex items-center justify-between">
                              <span className="font-bold text-zinc-800">
                                Max Discount
                              </span>
                              <div className="flex items-center gap-1.5">
                                {state.clampedDiscount > 0 && (
                                  <button
                                    type="button"
                                    onClick={() => clearDiscount(key)}
                                    className="rounded-full px-2 py-1 text-xs font-bold text-zinc-500 underline-offset-4 transition hover:bg-zinc-50 hover:text-zinc-700 hover:underline"
                                  >
                                    Clear
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => resetDiscount(key)}
                                  className="rounded-full px-2 py-1 text-xs font-bold text-amber-700 underline-offset-4 transition hover:bg-amber-50 hover:underline"
                                >
                                  Set to Max
                                </button>
                              </div>
                            </div>
                            <div className="mt-2 grid grid-cols-2 gap-2.5">
                              <div>
                                <label className="text-xs font-semibold text-zinc-500">
                                  Amount / unit
                                </label>
                                <div className="mt-1 flex items-center rounded-xl border border-zinc-200 bg-zinc-50 px-3 transition focus-within:border-amber-600 focus-within:bg-white focus-within:ring-4 focus-within:ring-amber-600/10">
                                  <span className="text-zinc-500">₹</span>
                                  <input
                                    type="number"
                                    inputMode="numeric"
                                    min={0}
                                    value={Math.round(
                                      state.pieces > 0
                                        ? discount.amount / state.pieces
                                        : 0
                                    )}
                                    onChange={(e) =>
                                      updateDiscountAmount(key, e.target.value)
                                    }
                                    className="w-full bg-transparent py-2 text-right text-base font-black text-zinc-950 outline-none"
                                  />
                                </div>
                              </div>
                              <div>
                                <label className="text-xs font-semibold text-zinc-500">
                                  Percentage
                                </label>
                                <div className="mt-1 flex items-center rounded-xl border border-zinc-200 bg-zinc-50 px-3 transition focus-within:border-amber-600 focus-within:bg-white focus-within:ring-4 focus-within:ring-amber-600/10">
                                  <input
                                    type="number"
                                    inputMode="decimal"
                                    min={0}
                                    step={0.1}
                                    value={discount.pct.toFixed(1)}
                                    onChange={(e) =>
                                      updateDiscountPct(key, e.target.value)
                                    }
                                    className="w-full bg-transparent py-2 text-right text-base font-black text-zinc-950 outline-none"
                                  />
                                  <span className="text-zinc-500">%</span>
                                </div>
                              </div>
                            </div>
                            <p className="mt-2 text-xs font-medium text-zinc-500">
                              Max allowed: {formatCurrency(
                                state.pieces > 0
                                  ? state.maxAmount / state.pieces
                                  : 0
                              )} / unit (
                              {formatPct(item.maxDiscountPct)})
                            </p>
                          </div>
                        </div>

                        {/* After Discount */}
                        <div className="border-t border-green-900/10 bg-gradient-to-br from-green-50 to-emerald-50 px-4 py-3 sm:px-5">
                          <p className="text-xs font-black uppercase tracking-[0.2em] text-green-800">
                            After Discount
                          </p>
                          <div className="mt-1.5 space-y-1.5 text-sm">
                            <PriceRow
                              label="Price (incl. tax)"
                              unitPrice={state.effectivePriceWithTax}
                              pieces={state.pieces}
                              total={state.dealValue}
                              variant="green"
                            />
                            <div className="flex items-center justify-between">
                              <span className="text-green-700">
                                Bijnis Margin after discount / unit
                              </span>
                              <span
                                className={`font-semibold ${
                                  state.marginAfterDiscountPct >= 5
                                    ? "text-green-700"
                                    : "text-red-700"
                                }`}
                              >
                                {formatCurrency(
                                  state.pieces > 0
                                    ? state.profitAfterDiscount / state.pieces
                                    : 0
                                )}
                                <span className="ml-1 text-xs">
                                  ({formatPct(state.marginAfterDiscountPct)})
                                </span>
                              </span>
                            </div>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </section>

                {/* Summary Cards */}
                {localSummary && (
                  <section className="space-y-4 lg:sticky lg:top-28">
                    <h2 className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.22em] text-zinc-500">
                      <span className="h-px w-6 bg-zinc-300" />
                      Deal Summary
                    </h2>
                    <div className="overflow-hidden rounded-2xl bg-white text-sm text-zinc-950 shadow-[0_16px_48px_rgba(45,35,20,0.07)] ring-1 ring-zinc-200/80">
                      <div className="grid grid-cols-2 border-b border-zinc-200/80">
                        <SummaryCell
                          label="Original Cart Value"
                          value={formatCurrency(localSummary.totalCartValue)}
                        />
                        <SummaryCell
                          label="Original Margin"
                          value={`${formatCurrency(
                            localSummary.totalProfit
                          )} (${formatPct(localSummary.overallMarginPct)})`}
                          align="right"
                        />
                      </div>
                      <div className="grid grid-cols-2 border-b border-zinc-200/80 bg-[#fbfaf7]">
                        <SummaryCell
                          label="Calculated Cart Value"
                          value={formatCurrency(localSummary.finalDealPrice)}
                        />
                        <SummaryCell
                          label="Calculated Margin"
                          value={`${formatCurrency(
                            localSummary.profitAfterDiscount
                          )} (${formatPct(
                            localSummary.marginAfterDiscountPct
                          )})`}
                          align="right"
                        />
                      </div>
                      <div className="grid grid-cols-2 border-b border-zinc-200/80">
                        <SummaryCell
                          label="Total Cart Discount"
                          value={`${formatCurrency(
                            localSummary.maxCartDiscountAmount
                          )} (${formatPct(localSummary.maxCartDiscountPct)})`}
                        />
                        <SummaryCell
                          label="Remaining Allowed"
                          value={formatCurrency(localSummary.cartLevelDiscountCap)}
                          align="right"
                        />
                      </div>
                      <div className="grid grid-cols-2">
                        <div className="border-r border-zinc-200/80 bg-[#fbfaf7] p-3">
                          <label
                            htmlFor="cart-level-discount"
                            className="text-sm font-bold text-zinc-800"
                          >
                            Cart Level Discount
                          </label>
                          <p className="mt-1 text-xs leading-5 text-zinc-500">
                            Editable with max discount validation
                          </p>
                        </div>
                        <div className="bg-[#fbfaf7] p-3">
                          <div className="flex items-center rounded-xl border border-zinc-200 bg-white px-3 transition focus-within:border-amber-600 focus-within:ring-4 focus-within:ring-amber-600/10">
                            <span className="text-zinc-500">₹</span>
                            <input
                              id="cart-level-discount"
                              type="number"
                              inputMode="numeric"
                              min={0}
                              max={Math.round(localSummary.cartLevelDiscountCap)}
                              value={Math.round(
                                localSummary.cartLevelDiscountAmount
                              )}
                              onChange={(e) =>
                                updateCartLevelDiscount(e.target.value)
                              }
                              className="h-10 w-full appearance-none bg-transparent px-2 text-right font-black text-zinc-950 outline-none placeholder:text-zinc-400"
                              placeholder="0"
                            />
                          </div>
                          <p className="mt-1.5 text-right text-[11px] font-medium text-zinc-500">
                            Max: {formatCurrency(localSummary.cartLevelDiscountCap)}
                          </p>
                        </div>
                      </div>
                    </div>
                  </section>
                )}
              </>
            )}
          </>
        )}
      </main>

      {/* Sticky Bottom Action Bar */}
      {localSummary && data && data.items.length > 0 && !loading && (
        <div className="fixed bottom-0 left-0 right-0 z-20 border-t border-white/70 bg-white/90 px-4 pb-6 pb-safe pt-3 shadow-[0_-18px_60px_rgba(45,35,20,0.16)] backdrop-blur-xl">
          <div className="mx-auto max-w-6xl">
            <div className="mb-3 flex items-center justify-between text-sm">
              <div>
                <p className="text-xs font-semibold text-zinc-500">Cart Value</p>
                <p className="font-black text-zinc-950">
                  {formatCurrency(localSummary.totalCartValue)}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs font-semibold text-zinc-500">
                  Final Deal Price
                </p>
                <p className="text-lg font-black text-green-700">
                  {formatCurrency(localSummary.finalDealPrice)}
                </p>
              </div>
            </div>
            {hasChanges && (
              <p className="mb-2 text-center text-xs font-semibold text-zinc-500">
                Tap recalculate to lock in updated quantities/discounts.
              </p>
            )}
            <button
              onClick={recalculateDeal}
              disabled={!hasChanges}
              className="w-full rounded-2xl bg-zinc-950 py-4 text-base font-black text-white shadow-lg shadow-zinc-950/20 transition active:scale-[0.99] active:bg-zinc-800 disabled:bg-zinc-200 disabled:text-zinc-400 disabled:shadow-none"
            >
              {hasChanges ? "Recalculate Deal" : "Deal Up-to-date"}
            </button>
          </div>
        </div>
      )}

      {isDiscountSheetOpen && (
        <div className="fixed inset-0 z-30 bg-zinc-950/45 backdrop-blur-sm">
          <section className="absolute inset-x-0 bottom-0 flex h-[94vh] flex-col overflow-hidden rounded-t-[1.5rem] bg-[#f8f5ef] shadow-[0_-30px_100px_rgba(0,0,0,0.3)] ring-1 ring-white/60 sm:rounded-t-[2rem]">
            <div className="relative z-40 border-b border-zinc-200/80 bg-white/80 px-4 py-3 backdrop-blur-xl sm:px-6 sm:py-4">
              <div className="mx-auto flex max-w-6xl items-start justify-between gap-4">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-amber-700">
                    Warehouse 31
                  </p>
                  <h2 className="mt-0.5 text-xl font-black tracking-tight text-zinc-950 sm:mt-1 sm:text-2xl">
                    Discount Eligible SKUs
                  </h2>
                  <p className="mt-0.5 text-xs text-zinc-500 sm:mt-1 sm:text-sm">
                    Prices mapped using customer pincode {cartPincode}.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsDiscountSheetOpen(false)}
                  className="rounded-2xl bg-zinc-950 px-4 py-2 text-sm font-black text-white transition active:scale-[0.98]"
                >
                  Close
                </button>
              </div>

              <div className="mx-auto mt-3 grid max-w-6xl grid-cols-[minmax(0,1fr)_9.5rem] gap-2 sm:mt-4 sm:grid-cols-[minmax(0,1fr)_18rem] sm:gap-3">
                <div className="rounded-2xl bg-white px-3 py-2.5 shadow-sm ring-1 ring-zinc-200/80 sm:px-4 sm:py-3">
                  <label
                    htmlFor="discount-sku-search"
                    className="text-[10px] font-black uppercase tracking-[0.16em] text-zinc-500 sm:text-xs"
                  >
                    Search
                  </label>
                  <input
                    id="discount-sku-search"
                    type="search"
                    value={discountSkuSearch}
                    onChange={(e) => setDiscountSkuSearch(e.target.value)}
                    placeholder="Product, color, size"
                    className="mt-0.5 w-full bg-transparent text-sm font-semibold text-zinc-950 outline-none placeholder:text-zinc-400 sm:mt-1 sm:text-base"
                  />
                </div>

                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setIsDiscountCategoryOpen((open) => !open)}
                    className="h-full w-full rounded-2xl bg-white px-3 py-2.5 text-left shadow-sm ring-1 ring-zinc-200/80 sm:px-4 sm:py-3"
                  >
                    <span className="block text-[10px] font-black uppercase tracking-[0.16em] text-zinc-500 sm:text-xs">
                      Category
                    </span>
                    <span className="mt-0.5 flex items-center justify-between gap-2 text-sm font-extrabold text-zinc-950 sm:mt-1 sm:text-base">
                      <span className="truncate">
                        {discountSkuCategory === "all"
                          ? "All"
                          : discountSkuCategory}
                      </span>
                      <span className="text-zinc-400">⌄</span>
                    </span>
                  </button>

                  {isDiscountCategoryOpen && (
                    <div className="absolute right-0 top-full z-50 mt-2 max-h-80 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-zinc-200">
                      <div className="border-b border-zinc-100 p-2">
                        <input
                          type="search"
                          value={discountCategorySearch}
                          onChange={(e) => setDiscountCategorySearch(e.target.value)}
                          placeholder="Search categories"
                          className="w-full rounded-xl bg-zinc-50 px-3 py-2 text-sm font-semibold text-zinc-950 outline-none ring-1 ring-zinc-200 placeholder:text-zinc-400"
                        />
                      </div>
                      <div className="max-h-60 overflow-y-auto p-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setDiscountSkuCategory("all");
                            setIsDiscountCategoryOpen(false);
                          }}
                          className="w-full rounded-xl px-3 py-2 text-left text-sm font-bold text-zinc-950 hover:bg-amber-50"
                        >
                          All categories
                        </button>
                        {filteredDiscountSkuCategoryOptions.map((category) => (
                          <button
                            key={category}
                            type="button"
                            onClick={() => {
                              setDiscountSkuCategory(category);
                              setIsDiscountCategoryOpen(false);
                            }}
                            className="w-full rounded-xl px-3 py-2 text-left text-sm font-bold text-zinc-700 hover:bg-amber-50"
                          >
                            {category}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="relative z-0 min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
              <div className="mx-auto max-w-6xl">
                {discountSkuLoading ? (
                  <div className="rounded-3xl bg-white p-8 text-center text-sm font-bold text-zinc-500 shadow-sm ring-1 ring-zinc-200/80">
                    Loading discount eligible SKUs...
                  </div>
                ) : discountSkuError ? (
                  <div className="rounded-3xl bg-red-50 p-8 text-center text-sm font-bold text-red-700 ring-1 ring-red-200">
                    {discountSkuError}
                  </div>
                ) : filteredDiscountSkus.length === 0 ? (
                  <div className="rounded-3xl bg-white p-8 text-center text-sm font-bold text-zinc-500 shadow-sm ring-1 ring-zinc-200/80">
                    No discount eligible SKUs found.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {filteredDiscountSkus.map((item) => (
                      <article
                        key={`${item.variantid}|${item.sizeid}`}
                        className="overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-zinc-200/80"
                      >
                        <div className="flex gap-3 p-3 sm:p-4">
                          <div className="relative h-24 w-24 flex-shrink-0 overflow-hidden rounded-2xl bg-zinc-100 ring-1 ring-zinc-200 sm:h-32 sm:w-28">
                            {item.imageurl ? (
                              <Image
                                src={item.imageurl}
                                alt={item.ProductName}
                                fill
                                className="object-cover"
                                unoptimized
                              />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center text-xs text-zinc-400">
                                No img
                              </div>
                            )}
                          </div>

                          <div className="min-w-0 flex-1">
                            <div className="grid grid-cols-[minmax(0,1fr)_6.75rem] items-start gap-2 sm:grid-cols-[minmax(0,1fr)_7.5rem]">
                              <div className="min-w-0">
                                <p className="line-clamp-1 text-sm font-extrabold leading-5 text-zinc-950 sm:line-clamp-2 sm:text-base">
                                  {item.ProductName}
                                </p>
                                <p className="mt-0.5 line-clamp-2 text-xs font-semibold leading-4 text-zinc-500">
                                  {item.colorname} · {item.sizetext}
                                </p>
                              </div>
                              <span className="rounded-full bg-green-100 px-2 py-1 text-center text-[11px] font-extrabold leading-3 text-green-800 ring-1 ring-green-200 sm:text-xs sm:leading-4">
                                Max {formatPct(item.eligibleDiscount)} off
                              </span>
                            </div>

                            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                              <div className="min-w-0 rounded-2xl bg-amber-50 p-2 ring-1 ring-amber-100">
                                <p className="text-[11px] font-extrabold leading-3 text-amber-700">Landing Price</p>
                                <p className="mt-1 text-[15px] font-black leading-5 text-zinc-950 sm:text-base">
                                  {formatCurrency(item.landingPrice)}
                                </p>
                              </div>
                              <div className="min-w-0 rounded-2xl bg-green-50 p-2 ring-1 ring-green-100">
                                <p className="text-[11px] font-extrabold leading-3 text-green-700">Max Discounted Price</p>
                                <p className="mt-1 text-[15px] font-black leading-5 text-zinc-950 sm:text-base">
                                  {formatCurrency(
                                    item.landingPrice *
                                      (1 - item.eligibleDiscount / 100)
                                  )}
                                </p>
                              </div>
                              <div className="min-w-0 rounded-2xl bg-white p-2 ring-1 ring-zinc-200">
                                <p className="text-[11px] font-extrabold leading-3 text-zinc-500">Stock Left</p>
                                <p className="mt-1 text-sm font-black leading-5 text-zinc-950">
                                  {item.CurrentInventory} sets
                                </p>
                              </div>

                              {item.MRP > 0 && (
                                <div className="min-w-0 rounded-2xl bg-zinc-50 p-2 ring-1 ring-zinc-100">
                                  <p className="text-[11px] font-extrabold leading-3 text-zinc-500">MRP / Margin</p>
                                  <p className="mt-1 text-sm font-black leading-5 text-zinc-950">
                                    {formatCurrency(item.MRP)} ·{" "}
                                    {item.retailMarginPct === null
                                      ? "N/A"
                                      : formatPct(item.retailMarginPct)}
                                  </p>
                                </div>
                              )}
                            </div>

                            <p className="mt-2 truncate text-[11px] font-semibold text-zinc-400">
                              {item.mainCategoryName} × {item.categoryGroupName}
                            </p>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function PriceRow({
  label,
  unitPrice,
  pieces,
  total,
  variant,
}: {
  label: string;
  unitPrice: number;
  pieces: number;
  total: number;
  variant?: "green";
}) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="text-zinc-500">{label}</span>
      <span
        className={`text-right ${
          variant === "green" ? "text-green-800" : "text-zinc-950"
        }`}
      >
        <span className="font-semibold">{formatCurrency(unitPrice)}</span>
        <span className="text-zinc-400"> × {pieces} = </span>
        <span className="font-bold">{formatCurrency(total)}</span>
      </span>
    </div>
  );
}

function SummaryCell({
  label,
  value,
  align,
}: {
  label: string;
  value: string;
  align?: "right";
}) {
  return (
    <div
      className={`border-r border-zinc-200/80 p-3 last:border-r-0 ${
        align === "right" ? "text-right" : ""
      }`}
    >
      <p className="text-sm font-medium text-zinc-600">
        {label}
      </p>
      <p className="mt-1 text-sm font-black text-zinc-950">{value}</p>
    </div>
  );
}
