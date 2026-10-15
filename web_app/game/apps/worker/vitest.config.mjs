import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./src/cloudflare-workers-stub.ts", import.meta.url)),
    },
  },
});
