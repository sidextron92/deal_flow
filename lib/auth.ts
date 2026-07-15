import { NextRequest } from "next/server";

/**
 * Verify the shared Auth-Key the Gateway injects on authenticated routes.
 * Defense-in-depth: the Next server sits in the VPC with no auth of its own,
 * so a direct hit that bypasses the Gateway must be rejected here.
 *
 * Enforced only when AUTH_KEY is configured, so local dev (no gateway) still
 * works. Returns a 401 Response to short-circuit on failure, or null to proceed.
 */
export function checkAuthKey(request: NextRequest): Response | null {
  const expected = process.env.AUTH_KEY;
  if (!expected) return null; // not configured -> skip (local dev / direct testing)
  if (request.headers.get("auth-key") !== expected) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

/**
 * Seller id for the authenticated trader. The Gateway derives it from the
 * trader's validated token and injects it as the `Seller-Id` header. Falls back
 * to the SELLER_ID env var for local dev / direct testing.
 */
export function getSellerId(request: NextRequest): string | undefined {
  return request.headers.get("seller-id") ?? process.env.SELLER_ID ?? undefined;
}
