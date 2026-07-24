# deal_flow — data model & table reference

Context for anyone (human or AI) picking up deal_flow work. It documents the DB
tables this project reads, how they relate, and the two queries that drive the
feature. **DB: `shoekonnect_live` (AWS Aurora MySQL).** deal_flow is **read-only**
against it — no writes anywhere.

> Provenance: everything below was verified by querying prod (read-only) during
> development, except the one item explicitly marked "unconfirmed". If you extend
> this, verify against the DB and update this file — don't guess.

---

## 1. What deal_flow does (the mental model)

A **trader / FOS** (field salesperson) opens the Best Deal Calculator, types a
**retailer's phone**, and sees that retailer's **pending cart for the trader's own
dark store**, with margins and allowed discounts.

The scoping chain:

```
Fos-Id header (gateway-injected, from validated token)
   └─ fos_users.dsId                         (which dark store the FOS belongs to)
        └─ seller_master row where
             fmWarehouseId = dsId
             AND sellerType = 'BRAND_AGGREGATORS'
             AND factoryType = 'darkstore'    → userID = the DS's "seller id"
                 └─ truck_items WHERE sellerID = that userID  (this retailer's
                    cart lines sourced from THIS dark store)
```

Key idea: **a "dark store" (DS) is represented in the DB as a `seller_master`
row** (its aggregator seller). The trader deals on behalf of that seller. A
retailer's cart line is tied to a DS purely by its `truck_items.sellerID`.

---

## 2. Table reference

### Cart / catalog tables (used by the `/api/cart` query)

| Table | Role | Key columns (verified) |
|---|---|---|
| **truck_items** (`ti`) | The retailer's cart lines ("truck"). One row per added SKU line. | `userID` (retailer), **`sellerID`** (the seller/DS this line is sourced from — the DS link), `subSellerID`, `productID`, `variantID`, `sizeID`, `colorID`, `setCount` (# sets), `setSize` (pieces per set = "lotSize"), **`status`** (0 = pending/active, 2 = ordered/closed), **`orderType`** ('OnStock' / 'PreOrder'), `sellerPrice`, `sellerDiscount`, `extSellerPrice`, `sellerPriceFactor` |
| **user_master** (`um`) | Retailers/buyers (and users). | `userid`, **`companyPhone`** ← deal_flow matches the entered phone on **`companyPhone`, NOT `phone`** |
| **seller_master** (`sma`/`sm`) | Sellers — incl. dark stores, brands, factories. | **`userID`** (= the `sellerID` used everywhere), **`fmWarehouseId`** (= `dsId` for dark stores), **`sellerType`** ('BRAND_AGGREGATORS' / 'BRAND' / 'PRODUCTION_FACTORIES' …), **`factoryType`** ('darkstore' / 'non-consumer' / 'consumer' …), **`isProductActive`**, `companyPhone`, `billingPincode`, `marginP`, `aggregatorId`, `parentId` (…70+ cols) |
| **variant_size_stock** (`vss`) | Per-seller stock for a variant+size. | `variantID`, `sizeID`, `sellerID`, **`quantity`** (stock), **`isVisible`** |
| **variants** (`v`) | Variant → product/color + image. | `variantID`, `productID`, `colorID`, `defImage` |
| **products** (`p`) | Product master. | `productid`, `mrp`, **`transferPrice`** (cost basis), `productName` |
| **colors** (`c`) | Color name. | `uniqueId`, `colorName` |
| **size_master** (`sm`) | Size label. | `sizeID`, `sizeText` |
| **address_details** (`ad`) | Retailer addresses (for pincode). | `userID`, **`isSelected`** (=1 → the active address), `zipcode` (pincode) |
| **pre_shelfout_discount_skus** (`psds`) | Pre-approved per-SKU discount at a warehouse. | `variantId`, `sizeId`, `warehouseId` (= DS `fmWarehouseId`), `status` (=1 active), `endDate`, **`eligibleDiscount`** (max discount %) |

### FOS / org tables (used to resolve the seller)

| Table | Role | Key columns (verified) |
|---|---|---|
| **fos_users** | The FOS/trader team (salespeople). | **`fosId`**, `skID` (e.g. 'SK11335'), `email`, **`dsId`** (the DS the FOS belongs to), `userType`, `isSuperUser`, `userConfig` (JSON), `sk_static_token`, `mappedSuperCategory`. **No `sellerId` column** — it's derived. |
| **fos_buyer_user_mappings_ds** | Maps a FOS to the retailers they serve. | `fosId`, `skID`, **`buyerid`** (= retailer `user_master.userid`), `phoneNo` (retailer phone), `categoryId`, `priority` |

---

## 3. The two queries that matter

### Seller resolution — `lib/services/mysql.ts` → `resolveSellerIdFromFos(fosId)`
```sql
SELECT sm.userID AS sellerId
FROM fos_users fu
INNER JOIN seller_master sm
        ON sm.fmWarehouseId = fu.dsId
       AND sm.sellerType     = 'BRAND_AGGREGATORS'
       AND sm.factoryType    = 'darkstore'
       AND sm.isProductActive = 1
WHERE fu.fosId = ?
LIMIT 5;
```
All four conditions are the **exact dark-store definition** and each matters: a
warehouse holds several `seller_master` rows (`PRODUCTION_FACTORIES`, non-darkstore
aggregators…), and `isProductActive=1` skips deactivated dark stores. Verified
against prod: with the full filter every resolving FOS maps to **exactly one**
active DS (no ambiguity); `fosId 100116 → dsId 35 → 1490494483`,
`6018 → 10 → 1490488240`. FOS whose `dsId` has no active dark store (incl. ~93%
with a null `dsId`) resolve to `null` → `400 "no seller found for this trader"`.

### The cart — `lib/services/mysql.ts` → `fetchCartFromMySQL(phone, sellerId)`
Reads `truck_items` joined to the catalog tables above, filtered by:
```sql
WHERE ti.status = 0          -- pending/active (NOT status=2 = ordered)
  AND ti.sellerid = ?        -- the trader's DS seller (from resolution above)
  AND um.companyPhone = ?    -- the retailer (companyPhone!)
  AND ti.orderType = 'OnStock'
  AND vss.isVisible = 1
  AND vss.quantity > 0
GROUP BY ti.sellerID, ti.variantID, ti.sizeID;
```
`fetchCartExclusions` runs the same scope minus the stock/OnStock filters to count
what got dropped (`outOfStock`, `preOrder`) so the UI can explain an empty/partial
cart. `retailerExists` is a `SELECT 1 FROM user_master WHERE companyPhone=?` used
only to distinguish "unknown number" from "no cart under this DS".

---

## 4. Retailer ↔ DS ↔ truck mapping (verified)

- **A DS is a `seller_master` row** where `sellerType='BRAND_AGGREGATORS' AND
  factoryType='darkstore' AND isProductActive=1`. (~17 exist.)
- **A truck line's DS = its `truck_items.sellerID`.** `truck_items` has **no
  `dsId`/warehouse column** — the only DS link is `sellerID` (→ the aggregator
  seller). `subSellerID` also exists (deal-flow uses `sellerID`).
- **A retailer is NOT tied to one DS.** A single retailer's active truck spans
  **many sellers/DSes at once** (verified: one retailer had 150+ lines across 10+
  sellers, mixing several dark stores + non-darkstore aggregators). deal_flow's
  `sellerid = ?` filter therefore shows only the slice sourced from *this* trader's
  DS — the same retailer shows a different cart to a different DS's trader.
- **UNCONFIRMED (ask the team):** the *rule* that stamps a given truck line with a
  particular `sellerID`/DS at add-time (pincode serviceability? stock? SKU owner?).
  That's application logic, not a lookup table found in the DB.

---

## 5. Pricing & other services

- **Price engine** — `lib/services/price-api.ts` POSTs `variantIds` +
  `destinationPincode` to `…/g/ss/price-engine/get-variant-price-detail-v2`
  (header `Token-X`, currently a **hardcoded** token — move to env). Returns
  pincode-specific `landingPrice` / `landingPriceBeforeTax` per item; falls back to
  the row's own `MRP`/`transferPrice` if a variant is missing.
- **Discount-eligible SKUs** — `/api/discount-eligible-skus?pincode=…` →
  `fetchDiscountEligibleSkus(pincode)` (queries `pre_shelfout_discount_skus` +
  catalog). Not seller-scoped; only needs `pincode` + Auth-Key.

---

## 6. Gotchas & history (save yourself the debugging)

- **Phone match is `companyPhone`, not `phone`.** Entering a retailer's other
  number returns an empty cart.
- **`status = 0` only.** `status = 2` rows are ordered/closed and never show — a
  populated-looking retailer can still return an empty deal cart.
- **Seller was once read from `token.appInfo.sellerId`** — but real FOS tokens
  ship `appInfo` **truncated to ~100 chars** (userservice), dropping `sellerId`.
  That whole class is gone now: the seller is derived from `fosId` (§3). Don't
  reintroduce a dependency on `appInfo.sellerId`.
- **Every catalog JOIN in the cart query is `INNER`** — a missing selected address
  / color / size row silently drops a line. First place to look if an item
  "disappears".
- **Aurora has no read-replica instance** — the `cluster-ro…` endpoint is the
  writer (`@@read_only=0`). Read-only safety comes from a SELECT-only user, not the
  endpoint.
- The gateway injects `Seller-Id` too, but deal_flow **ignores it** now (derives
  from `Fos-Id`). `Seller-Id` is dead weight pending a gateway cleanup.

---

## 7. Open product decisions (revisit later)

- **Retailer visibility scope — DS-level (current), by design for now.** A FOS can
  look up **any** retailer's cart under their dark store (the cart is matched only
  by `sellerID` = the DS + `companyPhone` = the entered number). It does **not**
  restrict to the FOS's *own* assigned retailers in `fos_buyer_user_mappings_ds`.
  Product confirmed DS-level visibility is acceptable for now (2026-07-24);
  flagged to revisit if per-FOS retailer scoping is ever needed. If you tighten
  it, the hook is: additionally require the retailer's `userid` to appear in
  `fos_buyer_user_mappings_ds` for the caller's `fosId`.
- **Null-`dsId` FOS → `400 "no seller found for this trader"` is intended**
  (~93% of `fos_users` have no `dsId`; they aren't Deal-Flow/darkstore FOS).
