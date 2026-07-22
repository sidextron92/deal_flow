import { NextResponse } from "next/server";

// Lightweight liveness probe. Intentionally does NOT touch the DB so that
// k8s/load-balancer health checks stay green even when downstream MySQL is
// unavailable. For a readiness/dependency check, add a separate endpoint.
export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "deal_flow",
    timestamp: new Date().toISOString(),
  });
}
