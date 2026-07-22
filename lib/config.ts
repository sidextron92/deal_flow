// Shared base path — MUST match `basePath` in next.config.ts.
// NEXT_PUBLIC_* is inlined into the client bundle at build time, so the value
// used here and in next.config.ts must resolve identically.
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "/g/deal-flow";

// Prefix an app-relative API path with the basePath. Next auto-prefixes
// next/link, next/image and the router, but NOT raw fetch() calls — so client
// fetches must go through this helper to resolve under the gateway prefix.
export function apiPath(path: string): string {
  return `${BASE_PATH}${path}`;
}
