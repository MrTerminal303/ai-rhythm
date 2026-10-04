import { defineConfig } from "vitest/config";
export default defineConfig({
  // Next.js needs tsconfig jsx:"preserve"; vite's oxc honors it and leaves JSX raw,
  // which vitest can't parse — force automatic JSX only for the test transform
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node", // .test.tsx files opt into jsdom via `// @vitest-environment jsdom` docblock
    include: ["src/**/*.test.{ts,tsx}"],
    passWithNoTests: true, // brief-exact config left this off; empty `test` gate must stay green until first test file lands (review round 1 fix)
  },
});
