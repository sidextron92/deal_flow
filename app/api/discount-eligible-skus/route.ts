import { NextRequest } from "next/server";
import { fetchDiscountEligibleSkus } from "@/lib/services/discount-eligible-skus";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const pincode = request.nextUrl.searchParams.get("pincode");

    if (!pincode) {
      return Response.json({ error: "pincode is required" }, { status: 400 });
    }

    const items = await fetchDiscountEligibleSkus(pincode);
    return Response.json({ pincode, items });
  } catch (err) {
    console.error("[API /discount-eligible-skus GET] Error:", err);
    return Response.json(
      {
        error: "Failed to fetch discount eligible SKUs",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
