# Referência — Variáveis de ambiente

> Contrato de configuração da API. Fonte: [000-overview §6](../specs/000-overview.md#6-contrato-de-configuração-env-vars).
> Local: `.env.local` (gitignored). Vercel: Project Settings → Environment Variables, separadas por
> `Development` / `Preview` / `Production`. Valores **nunca** entram no repositório.

Template para copiar para `.env.local`:

```dotenv
# --- Wave 0 — plataforma
APP_ENV=development
LOG_LEVEL=info
CORS_ALLOWED_ORIGINS=http://localhost:4321

# --- Wave 1 — Supabase / Postgres
SUPABASE_URL=
SUPABASE_PROJECT_REF=
# Runtime: role dedicada lp_api via pooler (transaction mode, porta 6543), TLS verify-full.
# A role é criada na wave 1; até lá deixe vazio.
DATABASE_URL=
DATABASE_CA_CERT=
# Somente Supabase CLI / migrations (dev e CI) — nunca usados pela API em runtime
SUPABASE_ACCESS_TOKEN=
SUPABASE_DB_PASSWORD=

# --- Wave 3 — Upstash Redis, Turnstile, hashing
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
TURNSTILE_SECRET_KEY=
# gerar com: openssl rand -base64 32
HASH_PEPPER=

# --- Wave 5 — QStash, Meta CAPI, GA4 MP
QSTASH_URL=
QSTASH_TOKEN=
QSTASH_CURRENT_SIGNING_KEY=
QSTASH_NEXT_SIGNING_KEY=
PUBLIC_API_BASE_URL=
META_PIXEL_ID=
META_CAPI_ACCESS_TOKEN=
META_GRAPH_API_VERSION=v25.0
META_TEST_EVENT_CODE=
GA4_MEASUREMENT_ID=
GA4_API_SECRET=

# --- Wave 7 — front (valor público)
TURNSTILE_SITE_KEY=

# --- Wave 9 — CRM staff auth
SUPABASE_JWT_ISSUER=
SUPABASE_JWKS_URL=

# --- Wave 11 — IA
AI_GATEWAY_API_KEY=
```

## Notas

- **Não é necessária** a `service_role`/secret key do Supabase no runtime (ADR-0003).
- `DATABASE_URL` usa o usuário `lp_api.<project_ref>` e `sslmode=verify-full`; o CA vai em
  `DATABASE_CA_CERT` (PEM em base64, baixado no painel do Supabase → Database → SSL).
- Em CI, usar as chaves de teste do Turnstile (ver [lead-capture §6](../specs/lead-capture.md#6-anti-abuso)).
- `META_TEST_EVENT_CODE` só em `development`/`preview`; o config rejeita em `production`.
