import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node", // .test.tsx files opt into jsdom via `// @vitest-environment jsdom` docblock
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
