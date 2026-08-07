import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces a minimal .next/standalone server bundle with only the
  // dependencies actually used, traced automatically -- keeps the Docker
  // image small instead of shipping the full node_modules tree.
  output: "standalone",
  experimental: {
    serverActions: {
      // Default is 1MB, which is well under the answer bank's PDF bulk
      // import cap (20MB, see MAX_PDF_BYTES in admin/answer-bank/actions.ts)
      // and was already silently under the 4MB single-image-upload cap too.
      bodySizeLimit: "24mb",
    },
  },
};

export default nextConfig;
