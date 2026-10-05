import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@airhythm/shared"], // shared exports raw .ts — let Next compile it instead of failing at first build
  experimental: {
    // shared's index.ts uses ESM-style "./x.js" specifiers over .ts sources; webpack has no default .js→.ts alias (tsc/vite do)
    extensionAlias: { ".js": [".js", ".ts", ".tsx"], ".jsx": [".jsx", ".tsx"] },
  },
};
export default nextConfig;
