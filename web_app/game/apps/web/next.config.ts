import type { NextConfig } from "next";

// I2 (W2 final security review): hardening headers on every route.
// CSP starts permissive on script (Next dev tooling / hydration may need
// 'unsafe-inline'+'unsafe-eval'); everything else stays tight. Vercel-level
// HSTS is out of scope here (deploy platform config).
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "img-src 'self' data: blob:",
      "style-src 'self' 'unsafe-inline'", // Next injects inline styles
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'", // permissive script — see note above
      "connect-src 'self'", // fetch/audio/atlas are same-origin
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@airhythm/shared"], // shared exports raw .ts — let Next compile it instead of failing at first build
  experimental: {
    // shared's index.ts uses ESM-style "./x.js" specifiers over .ts sources; webpack has no default .js→.ts alias (tsc/vite do)
    extensionAlias: { ".js": [".js", ".ts", ".tsx"], ".jsx": [".jsx", ".tsx"] },
  },
  headers: async () => [{ source: "/(.*)", headers: securityHeaders }],
};
export default nextConfig;
