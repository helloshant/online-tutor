import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces a minimal .next/standalone server bundle with only the
  // dependencies actually used, traced automatically -- keeps the Docker
  // image small instead of shipping the full node_modules tree.
  output: "standalone",
  experimental: {
    serverActions: {
      // Default is 1MB, which is well under a bulk import submission (a
      // .txt file up to MAX_TEXT_FILE_BYTES plus several diagram images at
      // up to MAX_IMAGE_BYTES each, see admin/answer-bank/actions.ts) and
      // was already silently under the single-image-upload cap too.
      bodySizeLimit: "24mb",
    },
  },
};

export default nextConfig;
