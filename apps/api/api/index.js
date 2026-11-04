// Vercel Function entrypoint: serves the esbuild bundle (`pnpm run build` -> dist/index.js).
// Vercel's per-file TypeScript transpile keeps the `#/...ts` subpath imports (ADR-0007), which do not
// exist at runtime, so the function never loads src/ directly. Lint skips this shim (no logic; the
// parent-relative import is the only way to reach the build output).
export { default } from '../dist/index.js';
