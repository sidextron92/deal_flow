"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import {
  CalculatedCartItem,
  CartResponse,
  DiscountOverride,
} from "@/lib/types";

function formatCurrency(value: number): string {
  return `₹${Math.round(value).toLocaleString("en-IN")}`;
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

  const phoneDigits = useMemo(() => phone.replace(/\D/g, ""), [phone]);
  const isValidPhone = phoneDigits.length === 10;

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

  const localSummary = useMemo(() => {
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
  }, [data, quantities, discounts, cartLevelDiscount]);

  const hasChanges = useMemo(() => {
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
  }, [data, quantities, discounts, baselineDiscounts, localSummary]);

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
          <p className="hidden max-w-xs text-right text-sm leading-5 text-zinc-600 sm:block">
            Fetch a customer cart and tune quantities or discounts before recalculating.
          </p>
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
                              {item.Brand} · {item.colorname}
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
