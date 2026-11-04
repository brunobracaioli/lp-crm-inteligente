# Deploy a preview of the API on Vercel

The API runs as one Vercel Function in `gru1`. Deploying is an external action: only the project owner (or an
agent with the owner's explicit go-ahead) runs it.

## How the function is built

`apps/api/vercel.json` turns off framework detection (`"framework": null`) and runs `pnpm run build`, which
bundles `src/index.ts` with esbuild into `dist/index.js`. The function entry is `apps/api/api/index.js`, a
one-line shim that re-exports the bundle, and a rewrite sends every path to it.

Why not the zero-config Hono preset: it transpiles each `.ts` file on its own and keeps the `#/…ts` subpath
imports (ADR-0007). Those files do not exist at runtime, so every request failed with `ERR_MODULE_NOT_FOUND`.

The static output is `dist/static`, which holds only a `robots.txt` that disallows crawling. It exists
because Vercel requires a non-empty output directory, and it keeps Vercel from serving repository files as
static assets. Every other path, including `/package.json` and `/api/index.js`, reaches the app and gets its
`404 not_found`.

## Project

| Setting | Value |
|---|---|
| Project | `lp-crm-api` (team `brunobracaioli-6330s-projects`) |
| Root directory | `apps/api` |
| Node.js | 24.x |
| Region | `gru1` |
| Git | not connected: a push does not deploy |
| Deployment Protection | Vercel Authentication on every deployment without a custom domain |

The project's first deployment always goes to production. It has no production variables, so it never boots.

## Deploy

From a clean checkout of the commit to deploy:

```bash
mkdir -p .vercel
printf '{"projectId":"prj_4BmCDK6P42JnUIujzM36GXfRc2Lt","orgId":"team_aESLkB5x0vfbkCvVPYuA3b8i"}' > .vercel/project.json
vercel deploy --yes --target preview --scope brunobracaioli-6330s-projects
```

## Smoke test through Deployment Protection

```bash
vercel curl https://<deployment>/v1/health --scope brunobracaioli-6330s-projects -- -s -i   # 200 {"status":"ok"}
vercel curl https://<deployment>/v1/crm/me --scope brunobracaioli-6330s-projects -- -s -i   # 401 problem+json
```

## Preview variables

The full list and meaning is in `docs/reference/environment.md`. The `lp_api` password, `HASH_PEPPER` and
`DATABASE_CA_CERT` are generated locally and added with `vercel env add <NAME> preview --sensitive` from a
file, so values never appear in a terminal or transcript. `DATABASE_CA_CERT` is the base64 PEM of
"Supabase Root 2021 CA" (SHA-256 `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`);
compare it with `prod-ca-2021.crt` from the Supabase dashboard.

Third-party credentials missing from the owner's `.env.local` can hold random values. They fail closed:

| Variable | Effect of the random value |
|---|---|
| `TURNSTILE_SECRET_KEY` | siteverify rejects it, so every lead fails the anti-bot step |
| `QSTASH_TOKEN` | publishing fails, and the outbox stays `pending` |
| `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` | `/internal/*` rejects every signature |

Replace them with the real values before testing those flows.

## Known limits of the preview

- Vercel Authentication answers `401` before the app for browsers and for QStash callbacks. A custom domain
  for the API, or a protection bypass that the QStash publisher forwards, is needed before the LP or QStash
  can reach the preview.
- `CORS_ALLOWED_ORIGINS` holds `https://localhost:4321` until the LP has a preview origin. No third party can
  serve that origin.
