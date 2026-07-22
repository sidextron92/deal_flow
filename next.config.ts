import type { NextConfig } from "next";
import path from "path";

// Served under the gateway prefix /g/deal-flow. Must match BASE_PATH in lib/config.ts.
// basePath is inlined into client bundles at build time (cannot change at runtime).
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "/g/deal-flow";

const nextConfig: NextConfig = {
  basePath,
  // Emit a self-contained .next/standalone server for the VPC container image.
  output: "standalone",
  // Pin tracing to this project so the build doesn't walk the parent multi-repo workspace.
  outputFileTracingRoot: path.resolve(__dirname),
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
