import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces a minimal .next/standalone server bundle with only the
  // dependencies actually used, traced automatically -- keeps the Docker
  // image small instead of shipping the full node_modules tree.
  output: "standalone",
  experimental: {
    serverActions: {
      // Next's own default (1MB) is well under this app's actual uploads --
      // a single Answer Bank image alone is capped at 4MB (addImage in
      // src/app/admin/answer-bank/actions.ts), and a bulk-import spreadsheet
      // with embedded images is capped at 20MB (MAX_SPREADSHEET_BYTES,
      // same file) -- so without raising this, both would already fail
      // before ever reaching the action. Set with headroom above the
      // largest of those, not tightly to it.
      bodySizeLimit: "24mb",
    },
  },
};

export default nextConfig;
