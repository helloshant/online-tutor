import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root to this folder so Turbopack doesn't pick up the
  // parent online-tutor app's lockfile.
  turbopack: { root: __dirname },
};

export default nextConfig;
