import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // `typedRoutes` lives at the top level in Next.js 16 (moved out of `experimental`).
  typedRoutes: false,
};

export default nextConfig;
