/**
 * Test-only no-op stub for the `server-only` marker package.
 *
 * `import "server-only";` is a build-time guard: in a Next.js production
 * build, the `default` export throws if a Client Component ever tries to
 * import a module marked server-only. The `react-server` export condition
 * resolves to an empty file in legitimate server contexts (Server
 * Components, Route Handlers, Server Actions), so production behaviour is
 * unaffected.
 *
 * Vitest (running in jsdom, with no `react-server` condition awareness)
 * would otherwise execute the throwing `default` export and break every
 * test that imports `@/lib/biometrics/face-service-client` transitively.
 *
 * This stub is wired in ONLY via the Vitest alias in `vitest.config.ts`,
 * so the production guard in the real `server-only` package remains
 * fully intact and untouched for `next build`.
 *
 * If you ever see this file referenced outside of `vitest.config.ts`,
 * that's a smell — do not weaken the production server-only boundary.
 */
export {};
