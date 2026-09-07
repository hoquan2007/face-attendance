// Flat ESLint config for Next.js 16 + React 19.
// `eslint-config-next` (>= 16) ships as a Flat config and exposes two sub-configs:
//   - eslint-config-next/core-web-vitals
//   - eslint-config-next/typescript
// `next lint` was removed in Next.js 16; we run ESLint directly via `eslint .`.

import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

export default [
  ...coreWebVitals,
  ...typescript,
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts"],
  },
];
