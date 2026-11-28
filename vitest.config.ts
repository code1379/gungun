import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({
  resolve: {
    alias: {
      "@gungun/domain": resolve("packages/domain/src/index.ts"),
      ssh2: resolve("apps/desktop/node_modules/ssh2/lib/index.js"),
    },
  },
  test: {
    exclude: ["tests/**/*.real.test.ts", "tests/**/*.core.test.ts", "**/node_modules/**"],
    include: ["tests/**/*.test.ts", "scripts/**/*.test.ts"],
    testTimeout: 30000,
  },
});
