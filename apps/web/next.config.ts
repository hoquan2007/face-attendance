import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // `typedRoutes` lives at the top level in Next.js 16 (moved out of `experimental`).
  typedRoutes: false,
  // Force transpile better-auth packages to fix Turbopack subpath exports resolution.
  transpilePackages: [
    "better-auth",
    "@better-auth/core",
    "@better-auth/mongo-adapter",
    "@better-auth/utils",
  ],
};

export default nextConfig;
