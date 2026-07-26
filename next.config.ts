import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces a minimal .next/standalone server bundle with only the
  // dependencies actually used, traced automatically -- keeps the Docker
  // image small instead of shipping the full node_modules tree.
  output: "standalone",
};

export default nextConfig;
