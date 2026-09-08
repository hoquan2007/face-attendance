import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Vitest configuration for the Next.js web app.
 *
 * Mirrors the TypeScript path alias (`@/*` -> `./src/*`) from tsconfig.json
 * so tests can import via `@/lib/env` etc.
 *
 * Phase 2: load `.env.local` into `process.env` before any module is
 * imported so boot-time env validation does not throw when running
 * tests. We deliberately do NOT override pre-existing process.env
 * values — explicit CI / shell variables win.
 */
function loadEnvLocal() {
  const envPath = resolve(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvLocal();

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
    // The pre-existing integration test (`session-integration.test.ts`)
    // connects to a real MongoDB Atlas cluster and is gated by an
    // explicit `describe.skipIf(SKIP)` based on `MONGODB_URI`. We
    // explicitly exclude it from the default Vitest run because it
    // requires a network connection to MongoDB Atlas that is not
    // available in every developer environment; CI / integration
    // pipelines can opt it back in by running vitest with the file
    // explicitly listed.
    exclude: ["src/**/session-integration.test.ts"],
  },
});
