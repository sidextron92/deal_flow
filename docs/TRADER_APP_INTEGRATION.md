# Deal Flow — Trader App integration contract

Audience: the FOS/RM app (`com.bizcrum.rm.app`) team.
Goal: embed the **Best Deal Calculator** in the trader app, behind a feature flag.

---

## 1. Integration model — it's a **WebView**, not native API calls

Deal Flow is a self-contained web app (Next.js) served through the gateway at a
single base path. **You embed the URL in a WebView; the page makes its own API
calls.** You do **not** build native screens or call the `/api/*` endpoints
directly (they're documented in §5 for reference/debugging only).

**Entry point (open this in the WebView):**
```
https://api.bijnis.com/g/deal-flow
```
The initial page load is **public** (no auth). The page then calls its `/api/*`
endpoints, which **require auth** — see §3.

---

## 2. Feature flag

Gate the **entry point** (the menu item / button that opens the WebView) behind a
remote flag, e.g. `deal_flow_enabled`. When off, don't show the entry. No
server-side flag is needed — the gateway route only exists in prod and is
already live, so the app flag alone controls exposure.

---

## 3. Auth — inject FOS headers into **every** WebView request (the critical part)

The deal_flow page's own `fetch()` calls attach **no** auth. In the app you must
inject the FOS auth + context headers into **all** requests to `/g/deal-flow/*`.
`react-native-webview`'s `source={{ headers }}` only applies to the **top-level
navigation**, not sub-requests — so patch `fetch`/`XMLHttpRequest` via
`injectedJavaScriptBeforeContentLoaded`.

**Headers the app must inject** (same set the app already sends to other gateway
APIs like `/g/psfa/*`):

| Header | Value | Notes |
|---|---|---|
| `token` | FOS JWT | primary auth token |
| `Authorization` | FOS JWT | same token (gateway reads either) |
| `sessiontoken` | FOS JWT | same token |
| `User-Type` | `fos` | **required** — userservice fos-restriction |
| `Platform` | `react-android` / `react-ios` | required |
| `App-Version` | e.g. `3.1.7` | required |
| `Build-Version` | e.g. `202` | required |
| `Package-Name` | `com.bizcrum.rm.app` | required |
| `Device-Id` | device id | required |
| `Android-Sdk-Version` | e.g. `31` | required |

**Do NOT send** `Seller-Id`, `Fos-Id`, or `Auth-Key` — the **gateway derives and
injects these** from the validated token and strips any client-supplied copies
(anti-spoofing). The trader's `sellerId` comes from the token; the app does
nothing for it.

### RN WebView injection snippet
```js
const AUTH_HEADERS = {
  token: FOS_JWT,
  Authorization: FOS_JWT,
  sessiontoken: FOS_JWT,
  'User-Type': 'fos',
  Platform: 'react-android',
  'App-Version': appVersion,
  'Build-Version': buildVersion,
  'Package-Name': 'com.bizcrum.rm.app',
  'Device-Id': deviceId,
  'Android-Sdk-Version': sdkVersion,
};

const injected = `
(function () {
  var H = ${JSON.stringify(AUTH_HEADERS)};
  var of = window.fetch;
  window.fetch = function (input, init) {
    init = init || {};
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('/g/deal-flow/api/') !== -1) {
      init.headers = Object.assign({}, init.headers || {}, H);
    }
    return of(input, init);
  };
  var oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__df = (u||'').indexOf('/g/deal-flow/api/') !== -1; return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () { if (this.__df) { for (var k in H) this.setRequestHeader(k, H[k]); } return os.apply(this, arguments); };
  true;
})();
`;

<WebView
  source={{ uri: 'https://api.bijnis.com/g/deal-flow' }}
  injectedJavaScriptBeforeContentLoaded={injected}
  sharedCookiesEnabled={false}
/>
```

**Token refresh:** if the JWT can expire mid-session, re-inject the current token
(the app already manages FOS token lifetime for other webviews) — a stale token
surfaces as `401` on the `/api/*` calls (the UI shows "Failed to load cart").

---

## 4. What the trader does in the UI

Enters a **retailer phone number** (the retailer's registered `companyPhone`).
The page loads that retailer's on-stock cart **for this trader's seller**, shows
per-item pricing/margin/discount and a live deal summary, and a "Discount
Eligible SKUs" sheet. All seller-scoped by the token — a trader only ever sees
their own seller's carts.

---

## 5. API reference (what the WebView calls — FYI / debugging)

Base: `https://api.bijnis.com/g/deal-flow`. All `/api/*` except `/api/health`
require the §3 headers. Auth failures → `401 {"status":401,"message":"Unauthorized"}`.

### `GET /api/health` — public
Liveness. `200` when up.

### `GET /api/cart?phone=<companyPhone>`
The retailer's deal cart, scoped to the trader's seller (from token).
- `phone` (required): retailer's `companyPhone`.
- **200** → `CartResponse` (below). `items: []` with `200` = retailer has no
  on-stock cart under this seller (not an error).
- **400** `phone is required` / `seller context missing` (the latter only if the
  gateway didn't inject `Seller-Id` — should not happen in the app).
- **500** `Failed to fetch cart`.

### `POST /api/cart`
Recalculate the deal after the trader edits quantities / applies discounts.
```jsonc
// body
{
  "phone": "9876543210",
  "quantities": [ { "variantid": 123, "sizeid": 45, "setCount": 2 } ], // optional
  "discounts":  [ { "variantid": 123, "sizeid": 45, "amount": 10 } ]    // optional; use amount OR pct
}
```
- **200** → `CartResponse` (recomputed).

### `GET /api/discount-eligible-skus?pincode=<pincode>`
SKUs eligible for discount for a pincode (the UI passes the cart's pincode).
- `pincode` (required).
- **200** → `{ "pincode": string, "items": DiscountEligibleSku[] }`.
- **400** `pincode is required`.

---

## 6. Response schemas (TypeScript)

```ts
interface CartResponse {
  phone: string;
  items: CalculatedCartItem[];
  summary: DealSummary;
  excluded: { outOfStock: number; preOrder: number }; // cart lines filtered out of the deal
}

interface CalculatedCartItem {
  // identity / display
  userid: string; sellerid: string; fmWarehouseid: string;
  productId: number; variantid: number; sizeid: number;
  ProductName: string; colorname: string; sizetext: string; imageurl: string;
  pincode: string; lotSize: number; CurrentInventory: number;
  // quantities / prices
  setCount: number; pieces: number;
  MRP: number; purchasePriceWithoutTax: number;
  landingPriceBeforeTax: number; landingPrice: number;
  totalValue: number; dealValue: number;
  // margins / discounts
  profitAmount: number; profitMarginPct: number;
  maxDiscountPct: number; maxDiscountAmount: number;
  discountAmount: number; discountPct: number;
  effectivePriceWithTax: number;
  profitAfterDiscount: number; marginAfterDiscountPct: number;
  eligibleDiscount: number; retailerMargin: number;
}

interface DealSummary {
  totalCartValue: number;
  totalProfit: number;
  overallMarginPct: number;
  maxCartDiscountPct: number;
  maxCartDiscountAmount: number;
  finalDealPrice: number;
  profitAfterDiscount: number;
  marginAfterDiscountPct: number;
}

interface DiscountEligibleSku {
  warehouseid: number; productId: number; variantid: number; sizeid: number;
  MRP: number; purchasePriceWithoutTax: number; retailerMargin: number;
  ProductName: string; colorname: string; sizetext: string; imageurl: string;
  CurrentInventory: number; eligibleDiscount: number;
  categoryGroupName: string; mainCategoryName: string;
  performanceData: string | null;
  landingPriceBeforeTax: number; landingPrice: number;
  retailMarginPct: number | null;
}
```

---

## 7. Rollout / rollback

- **Rollout:** ship the flagged WebView entry; enable `deal_flow_enabled` for a
  pilot cohort of RMs, then widen.
- **App-side rollback:** turn the flag off — no backend change.
- **Backend rollback (ops):** the gateway feature is gated on `DEAL_FLOW_URL`;
  unsetting it makes `/g/deal-flow` return 404 fleet-wide. (Independent of the
  app flag; the app flag is the normal control.)

---

## 8. Security notes

- Pricing / margin / discount data is exposed **only** behind FOS auth — every
  `/api/*` (except health) is validated against userservice with a `fos`
  restriction, and the seller is bound to the token. Do not add any path that
  bypasses this.
- Never inject `Seller-Id`/`Fos-Id`/`Auth-Key` from the client — the gateway owns
  them.
```
