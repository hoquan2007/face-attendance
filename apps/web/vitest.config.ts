import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Vitest configuration for the Next.js web app.
 *
 * Mirrors the TypeScript path alias (`@/*` -> `./src/*`) from tsconfig.json
 * so tests can import via `@/lib/env` etc.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
  },
});
