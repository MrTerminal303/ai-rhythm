import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  // Next.js needs tsconfig jsx:"preserve"; vite's oxc honors it and leaves JSX raw,
  // which vitest can't parse — force automatic JSX only for the test transform
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    // W3 T14: beatmap-formats is a sibling workspace package not declared in web's deps
    // (same reason import/page.tsx uses a relative dynamic import) — alias it for tests only.
    alias: { "@airhythm/beatmap-formats": path.resolve(here, "../../packages/beatmap-formats/src/index.ts") },
  },
  test: {
    environment: "node", // .test.tsx files opt into jsdom via `// @vitest-environment jsdom` docblock
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
