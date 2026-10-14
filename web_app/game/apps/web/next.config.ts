import type { NextConfig } from "next";

// I2 (W2 final security review) + A4 (W3 T9, D23): hardening headers on every
// route, dev/prod script-src split. Production removes 'unsafe-eval' (Next dev
// tooling / F5 refresh needs it; prod bundles do not) and adds 'wasm-unsafe-eval'
// narrowly — verified by the /spike-probe route (Worker blob + WebAssembly.compile
// under prod headers). 'unsafe-inline' is retained ONLY for App Router inline
// bootstrap scripts. The build-time NODE_ENV decides: Playwright webServer runs
// `pnpm build && pnpm start` (production), so e2e hits the prod policy.
const isProd = process.env.NODE_ENV === "production";
const csp = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'", // Next injects inline styles
  isProd
    ? "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'" // prod: NO unsafe-eval; wasm-unsafe-eval verified by /spike-probe (D23)
    : "script-src 'self' 'unsafe-inline' 'unsafe-eval'", // dev tooling
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "worker-src 'self' blob:",
  "connect-src 'self'", // fetch/audio/atlas are same-origin (T23 extends with exact Supabase origin)
  "font-src 'self'",
].join("; ");
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Content-Security-Policy", value: csp },
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
