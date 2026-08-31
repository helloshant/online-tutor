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
    // A SEPARATE cap from serverActions.bodySizeLimit above, and easy to
    // miss: src/proxy.ts runs on almost every route (its own matcher only
    // excludes static assets), and Next.js buffers/clones each such
    // request's body for proxy compatibility up to this limit regardless
    // of whether proxy() itself reads the body -- default 10MB. A request
    // over that gets silently truncated HERE, before a Server Action ever
    // sees it, which then fails downstream trying to parse the now-
    // incomplete multipart body ("Unexpected end of form") -- a real,
    // hard failure in practice, not the harmless partial-read the option's
    // own docs describe. Raising serverActions.bodySizeLimit alone (like
    // this file did before) does NOT cover this -- confirmed directly: a
    // 2-file, ~12MB archetype-miner DOCX submission failed here even after
    // that fix, since the proxy layer runs first and truncated it at 10MB
    // regardless. Matches serverActions.bodySizeLimit's own value so
    // neither is the tighter constraint for the same request.
    proxyClientMaxBodySize: "40mb",
  },
};

export default nextConfig;
