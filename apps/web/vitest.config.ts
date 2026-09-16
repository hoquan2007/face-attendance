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
      // `import "server-only"` in face-service-client.ts (and other
      // server-only modules) throws in the real package's default export
      // when imported from a Client Component. Vitest doesn't understand
      // the `react-server` export condition that Next.js uses, so we
      // alias the bare `server-only` specifier to a tiny no-op stub
      // inside the test runner ONLY. Production `next build` is
      // unaffected — it resolves the real package via its exports map.
      "server-only": fileURLToPath(
        new URL("./tests/stubs/server-only.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: [],
    include: ["src/**/*.{test,spec}.ts", "src/**/*.{test,spec}.tsx"],
    // The pre-existing integration test (`session-integration.test.ts`)
    // connects to a real MongoDB Atlas cluster and is gated by an
    // explicit `describe.skipIf(SKIP)` based on `MONGODB_URI`. We
    // explicitly exclude it from the default Vitest run because it
    // requires a network connection to MongoDB Atlas that is not
    // available in every developer environment; CI / integration
    // pipelines can opt it back in by running vitest with the file
    // explicitly listed.
    exclude: ["src/**/session-integration.test.ts"],
    // PHASE 5.1E4A NOTE: Use the `forks` pool with `isolate: true`
    // so every test file runs in a fully isolated child process.
    //
    // Several route-level tests mock module-level singletons
    // (`next/navigation.redirect / notFound`,
    // `@/lib/classes/class-read-service`, `@/lib/session`,
    // `@/lib/profile-service`, etc.) via `vi.mock(...)` factories
    // that close over local `mockXxx` variables. With the default
    // `threads` pool, vitest reuses one worker for many test
    // files and the module cache + the `mockXxx` closures leak
    // across files: a test that throws via the mocked
    // `redirect` / `notFound` then sees its sibling file's mock
    // implementation (or no implementation at all) and the page
    // resolves with JSX instead of throwing, producing
    // `promise resolved "{ … }" instead of rejecting` failures.
    //
    // Running each test file in its own forked, isolated worker
    // guarantees that `vi.mock(...)` closures, the module cache,
    // and the `vi.fn()` state all reset between files. The
    // trade-off is higher per-file startup cost, which is the
    // documented cost of strong isolation in vitest 2.1.x.
    pool: "forks",
    isolate: true,
  },
});
