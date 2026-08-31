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
      // was already silently under the single-image-upload cap too. Raised
      // from 24mb to give a multi-file archetype-miner paper submission
      // (admin/archetype-miner/actions.ts, up to MAX_FILES files at
      // MAX_FILE_BYTES each) real headroom -- a realistic batch of several
      // DOCX/PDF papers together comfortably exceeds what a single upload
      // ever needed.
      bodySizeLimit: "40mb",
    },
  },
};

export default nextConfig;
