# Implementation waves — LP + CRM Inteligente

> Specs de origem: [000-overview](../specs/000-overview.md), [lead-capture](../specs/lead-capture.md),
> [database](../specs/database.md), [tracking](../specs/tracking.md), [crm](../specs/crm.md).
> Este arquivo é a fonte da verdade do roadmap de ondas; a tabela do `NOTES.md` espelha a coluna Status.
> Revisão 2026-11-03: ondas 5–9 e 11 divididas em sub-ondas (`a` = sem conflito de arquivo /
> só docs ou código isolado; `b` = integração/wiring) para aumentar o paralelismo.

## Roadmap

| Onda | Entrega | Quem | Depende de | Paralela com | Status |
|------|---------|------|------------|--------------|--------|
| 0 | Fundação: monorepo, TS strict, Hono, platform kernel (inclui `crypto`), CI de segurança, ports congelados, env schema 0–5, deps 1–5 pré-instaladas | Claude (principal) | — | — | ✅ |
| 1 | Banco: schemas, tabelas, role `lp_api`, RLS, seed, pgTAP | subagent Sonnet | 0 | 2, 3, 7a, 9a, 11a | ✅ |
| 2 | Domínio + use case `SubmitLead` (VOs, agregado Lead, pipeline, score v1) com fakes | subagent Sonnet + revisão | 0 | 1, 3, 7a, 9a, 11a | ✅ |
| 3 | Adapters de borda: Turnstile, rate limit, idempotência (Upstash) | subagent Sonnet | 0 | 1, 2, 7a, 9a, 11a | ✅ |
| 4 | Slice `POST /v1/leads` ponta a ponta + deploy preview | Claude (principal) | 1, 2, 3 | 5a, 7a | 🟡 |
| 5a | Tracking isolado: domínio (consentimento, hashing com vetores Meta), `meta-capi-client`, `qstash-signature`, `qstash-publisher` — só unit/MSW | subagent Sonnet | 0 | 4, 7a | ✅ |
| 5b | Tracking wiring: rotas `/internal/v1/outbox/*`, `DispatchOutboxEvent`/`SweepOutbox` com Postgres, publish pós-commit, schedule IaC | Claude (principal) | 4, 5a | 6a, 7b, 8a | 🟡 |
| 6a | Hardening sem conflito: runbooks, roteiro k6, config ZAP, revisão do threat model | subagent Sonnet | 4 | 5b, 7b, 8a | ✅ |
| 6b | Hardening com conflito: migration de retenção + `crm.anonymize_lead`, Firewall como código, alertas, execução k6/ZAP | Claude (principal) | 5b, 6a | 7b, 8a | 🟡 |
| 7a | LP + formulário + Turnstile contra mock do OpenAPI (Prism) | Codex | 0 | 1–6 | ⬜ |
| 7b | LP integrada ao preview da API | Codex | 4, 7a | 5b, 6, 8a | ⬜ |
| 8a | Container GTM montado em workspace (sem publicar) a partir do contrato do dataLayer | Codex + Claude | 0 | 5b, 6, 7b | ⬜ |
| 8b | Publicação GTM + QA headless (dedup Pixel×CAPI) | Codex + Claude (publicar exige humano) | 5b, 7b, 8a | 9b | ⬜ |
| 9a | Contrato `/v1/crm/*` no OpenAPI + threat model staff auth | subagent Sonnet + revisão | 0 | 1–8 | ✅ |
| 9b | CRM API: staff auth, membros, pipeline, notas, export, LGPD do titular | Claude (principal) | 6b, 9a | 8b | 🟡 |
| 10 | CRM web (UI do pipeline e do lead) — começa contra mock da 9a | Codex | 9a (mock) · 9b (integração) | 11b | ⬜ |
| 11a | Preparação IA: eval set (≥ 30 leads sintéticos rotulados) + threat model OWASP LLM/Agentic | subagent Sonnet | 0 | 1–9 | ✅ |
| 11b | Inteligência: qualificação por IA, automações (SLA, round-robin), offline conversions | Claude (principal) | 9b, 11a | 10 | ⬜ |

**Caminho crítico**: 0 → {1, 2, 3} → 4 → 5b → 6b → 9b → 11b. Todo o resto roda em volta dele.

### Gates obrigatoriamente sequenciais

| Gate | Motivo |
|---|---|
| Onda 0 | Congela ports, env schema, lint de boundaries, CI e dependências. Sem ela nada paraleliza. |
| Composition root + `platform/config` (`src/index.ts`) | Escritor único, em sequência: 4 → 5b → 6b → 9b → 11b. |
| `supabase/migrations/` | A CLI aplica por ordem de timestamp; migrations paralelas geram aplicação fora de ordem no remoto. Escritor único: 1 → 6b → 9b → 11b. |
| `contracts/openapi.v1.yaml` | Fonte da verdade; escritor único por vez. 9a fecha o contrato do CRM antes de 9b e 10. |
| Ações externas (deploy preview/prod, publicar GTM, Meta Test Events, schedules QStash, Firewall) | Sessão principal, com confirmação humana. Subagents nunca executam. |
| Merge e `NOTES.md` | Um PR por vez; status atualizado só pela sessão principal. |
| `supabase start` / testes de integração | Uma stack local por máquina (portas 54321–54324). 1, 4, 5b, 6b e 9b não rodam integração ao mesmo tempo. |

### Acoplamentos resolvidos na Onda 0

1. **Lockfile**: as dependências de runtime/teste das ondas 1–5 são instaladas na 0 (`libphonenumber-js`, `@upstash/redis`, `@upstash/ratelimit`, `@upstash/qstash`, `postgres`, `msw`, `fast-check`, `jose`…). Ondas paralelas não alteram `package.json`/`pnpm-lock.yaml`; se precisarem, param e abrem PR separado.
2. **Env schema**: `platform/config` declara as variáveis das ondas 0–5 (as de waves futuras opcionais até a onda que as usa torná-las obrigatórias por ambiente).
3. **HMAC com `HASH_PEPPER`**: `platform/crypto` (HMAC-SHA256, SHA-256 hex, comparação constant-time) pertence à 0; 2 e 3 só consomem.
4. **Hash de idempotência**: o port `IdempotencyStore` recebe `requestHash: string` já calculado (normalização é da 2, armazenamento é da 3).
5. **AC-LC-13 dividido**: a 2 testa contra `domain/rules.ts` (sem I/O); a metade "satisfaz os CHECKs do banco" vira teste de integração da 4.
6. **6b → 9b é dependência real**: o `POST /v1/crm/leads/{id}/anonymize` chama `crm.anonymize_lead`, criada na migration de retenção da 6b.
7. **Ports do tracking** (`ConversionDestination`, `OutboxPublisher`, `SignatureVerifier`) congelados na 0 para a 5a rodar em paralelo à 4.

---

## Onda 0 — Fundação

- **Objetivo**: repositório pronto para receber slices com segurança, qualidade e observabilidade desde o primeiro commit.
- **Escopo**:
  - `pnpm` workspaces (`apps/api`, depois `apps/lp`, `apps/crm-web`), Node 24 (`.nvmrc`, `engines`), `packageManager` pinado.
  - `apps/api`: TypeScript strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `erasableSyntaxOnly`, `verbatimModuleSyntax`), alias `#/` (subpath imports, ADR-0007), ESLint (typescript-eslint strict-type-checked) + Prettier, regra de boundaries entre módulos (`no-restricted-imports`, ADR-0007), Vitest + fast-check.
  - `platform/`: `config` (Zod sobre env 0–5, falha no boot), `logger` (pino + redaction de `email|whatsapp|*_name|ip|token|authorization|cookie`), `correlation` (middleware `X-Request-Id`), `errors` (RFC 9457 + handler global sem vazamento), `http-security` (headers de 000 §5.1, CORS allowlist, body limit 16 KB), `metrics` (wrapper `metric()`), `otel` (`@vercel/otel`), `crypto` (HMAC/SHA-256).
  - Ports congelados (interfaces + tipos) em `modules/lead-capture/application/ports.ts`, `modules/crm/public-api.ts` (assinaturas) e `modules/tracking/application/ports.ts`.
  - Dependências das ondas 1–5 pré-instaladas (ver "Acoplamentos resolvidos").
  - Rota `GET /v1/health`. `vercel.json` (região `gru1`, `maxDuration`, headers).
  - CI `.github/workflows/ci.yml`: Actions pinadas por SHA, `permissions: contents: read`, jobs lint · typecheck · test · build · gitleaks · osv-scanner · Semgrep (regras: `sql.unsafe`, concat em SQL, `console.log`, `dangerouslySetInnerHTML`, `eval`) · `redocly lint`. Dependabot para npm + actions. Hooks versionados em `.githooks/` (pre-commit com gitleaks + `scripts/verify.sh`), ativados por `scripts/setup-dev.sh`.
- **Depende de / paralela com**: — / — (fundação, sempre sequencial).
- **Critérios de aceite**:
  - `pnpm -r lint && pnpm -r typecheck && pnpm -r test && pnpm -r build` verdes.
  - `npx @redocly/cli lint contracts/openapi.v1.yaml` com 0 erros.
  - Teste: `GET /v1/health` → 200 com os 8 headers de segurança; rota inexistente → 404 problem+json com `correlation_id`; erro lançado num handler de teste → 500 sem stack.
  - Teste: logger com objeto contendo `email`/`whatsapp`/`token` emite `[REDACTED]`.
  - Boot com env inválido falha com mensagem que cita a variável (sem o valor).
  - `gitleaks detect` limpo; Semgrep sem findings.
- **Goal command**: `/goal pnpm -r lint && pnpm -r typecheck && pnpm -r test && pnpm -r build && npx @redocly/cli lint contracts/openapi.v1.yaml && gitleaks detect --no-banner all exit 0, and tests for health headers, problem+json 404/500 and log redaction exist and pass, stop after 6 tries`

## Onda 1 — Banco de dados

- **Objetivo**: schema núcleo seguro por padrão, conforme [database](../specs/database.md) §1–5.
- **Escopo**: `supabase/config.toml` (API só `public`, `jwt_expiry = 900`), `supabase/migrations/<ts>_core_schema.sql` (schemas, tabelas, CHECKs, índices comentados, triggers `updated_at` e append-only, RLS ENABLE+FORCE, role `lp_api` + grants), `supabase/seed.sql` (workspace + form `frm_lp_principal` com origins de dev), `supabase/tests/*.sql` (pgTAP), `docs/how-to/rotate-db-role-password.md`, `docs/reference/database-schema.md` (gerado/derivado da spec).
- **Depende de / paralela com**: 0 / 2, 3 (só toca `supabase/` e docs de banco).
- **Critérios de aceite**: `supabase db reset` aplica sem erro; `supabase test db` passa AC-DB-01..10; `supabase db lint` sem erros; nenhuma senha/segredo nas migrations (gitleaks).
- **Goal command**: `/goal supabase db reset && supabase test db && supabase db lint exit 0 with pgTAP tests covering AC-DB-01 through AC-DB-10, stop after 6 tries`

## Onda 2 — Domínio e use case

- **Objetivo**: toda a regra de negócio de captação e do agregado Lead implementada e testada sem I/O.
- **Escopo**: `modules/lead-capture/domain` (regras de campo, pipeline Unicode, normalização de WhatsApp, `SubmissionSnapshot`), `modules/lead-capture/application/submit-lead.ts` (orquestra os ports na ordem de lead-capture §2), `modules/crm/domain` (Lead, Stage machine, LeadScore, Attribution), `modules/crm/application/register-inbound-lead.ts`; fakes in-memory dos ports em `test/fakes/`.
- **Depende de / paralela com**: 0 / 1, 3 (só `domain/` e `application/`, ports congelados).
- **Critérios de aceite**: AC-LC-02, 03, 11, 13 (metade sem I/O: todo valor aceito satisfaz `domain/rules.ts`), 15; AC-CRM-01..05; regras de R1–R7 cobertas com fakes (incl. honeypot, replay idempotente, `422` por hash divergente); cobertura ≥ 90% em `domain/` e `application/`.
- **Goal command**: `/goal pnpm --filter api test -- --coverage passes with >=90% line coverage in src/modules/*/domain and src/modules/*/application, and test names reference AC-LC-02,03,11,13,15 and AC-CRM-01..05, stop after 8 tries`

## Onda 3 — Adapters de borda (Upstash + Turnstile)

- **Objetivo**: implementações reais dos ports de proteção, resilientes a falhas.
- **Escopo**: `modules/lead-capture/infrastructure/turnstile-verifier.ts` (siteverify, timeout 3 s, valida resposta com Zod, mapeia `timeout-or-duplicate`/`invalid-input-response` → falha, rede → indisponível), `upstash-rate-limiter.ts` (IP, e-mail, form, bloqueio por falhas; chaves com HMAC `HASH_PEPPER` via `platform/crypto`; fail-open com métrica), `upstash-idempotency-store.ts` (SET NX EX 86400, estados `in_progress`/`completed`), `platform/net/client-ip.ts`.
- **Depende de / paralela com**: 0 / 1, 2 (só `infrastructure/` desses adapters + `platform/net`).
- **Critérios de aceite**: testes com MSW cobrem sucesso, `success:false`, hostname/action divergentes, `challenge_ts` velho, timeout → `unavailable`; testes do rate limiter com Redis fake/`@upstash/redis` mockado cobrem limite, `Retry-After` e fail-open; nenhum segredo ou IP cru em chaves Redis (assert sobre as chaves geradas).
- **Goal command**: `/goal pnpm --filter api test src/modules/lead-capture/infrastructure src/platform/net passes with tests for turnstile success/failure/hostname/action/stale/timeout, rate-limit block/retry-after/fail-open and idempotency in_progress/completed/hash-mismatch, stop after 6 tries`

## Onda 4 — Slice `POST /v1/leads` ponta a ponta

- **Objetivo**: endpoint funcionando contra Postgres real (local e preview) conforme o contrato.
- **Escopo**: `platform/db` (cliente `postgres`, TLS verify-full, `prepare:false`, `set_config` por transação, pool pequeno com `attachDatabasePool`), `modules/*/infrastructure/postgres-*.ts` (repos + UnitOfWork), `modules/lead-capture/presentation/http.ts` (rota Hono fina: guards → use case → resposta), wiring em `src/index.ts`, testes de integração com `supabase start`, teste de contrato (respostas validadas contra o OpenAPI), deploy de preview na Vercel com env vars de preview.
- **Depende de / paralela com**: 1, 2, 3 / 5a, 7a (integra tudo e toca o composition root).
- **Critérios de aceite**: AC-LC-01, 04..12, 13 (metade com banco: valores aceitos inseridos sem violar CHECK), 14, 16..18 passando em integração; respostas 2xx/4xx validadas contra `contracts/openapi.v1.yaml`; `curl` no preview com chave Turnstile de teste retorna `202` e a linha aparece no banco de preview; URL de preview registrada no `NOTES.md` para o Codex.
- **Goal command**: `/goal supabase start && pnpm --filter api test:integration passes including AC-LC-01,04-14,16-18 and OpenAPI response validation, and a curl POST /v1/leads to the Vercel preview returns 202, stop after 8 tries`

## Onda 5a — Tracking isolado (sem wiring)

- **Objetivo**: toda a lógica de conversão server-side pronta e testada sem banco nem rotas.
- **Escopo**: `modules/tracking/domain` (ConversionEvent, Delivery, regras de consentimento, normalização + SHA-256 de `em/ph/fn/ln/external_id`, montagem de `fbc`), `modules/tracking/infrastructure/{meta-capi-client,qstash-signature,qstash-publisher,ga4-mp-client}.ts` (desligado por flag), testes com MSW.
- **Depende de / paralela com**: 0 (ports do tracking congelados) / 4, 7a. Não toca `src/index.ts`, `platform/config` nem `supabase/`.
- **Critérios de aceite**: AC-TR-02, 03, 05, 06 no nível unit/MSW; hashing conferido contra vetores de teste da Meta; nenhum `access_token` em URL/log.
- **Goal command**: `/goal pnpm --filter api test src/modules/tracking passes with tests named AC-TR-02,03,05,06 and Meta hashing test vectors, stop after 6 tries`

## Onda 5b — Tracking wiring (Outbox + QStash + Meta CAPI)

- **Objetivo**: conversões server-side confiáveis e deduplicadas, respeitando consentimento.
- **Escopo**: `modules/tracking/application` (`DispatchOutboxEvent`, `SweepOutbox`) com repositório Postgres (`FOR UPDATE SKIP LOCKED`), `presentation` (rotas `/internal/v1/outbox/*`), publicação pós-commit com `waitUntil`, schedule do sweeper (script IaC `scripts/qstash-schedules.ts` idempotente — execução exige confirmação humana).
- **Depende de / paralela com**: 4, 5a / 6a, 7b, 8a.
- **Critérios de aceite**: AC-TR-01..07 (AC-TR-01 validado manualmente no Meta Test Events com `META_TEST_EVENT_CODE`); nenhum `access_token` em URL/log.
- **Goal command**: `/goal pnpm --filter api test src/modules/tracking and pnpm --filter api test:integration pass with tests named AC-TR-02..07, and a preview submission produces a meta_capi delivery with status sent, stop after 8 tries`

## Onda 6a — Hardening sem conflito de arquivo

- **Objetivo**: material operacional pronto antes do wiring final.
- **Escopo**: runbooks em `docs/how-to/` (incidente de flood, rotação de segredos, reprocessar dead letters), `perf/lead-capture.js` (k6, AC-LC-19), config do OWASP ZAP baseline, revisão do threat model.
- **Depende de / paralela com**: 4 / 5b, 7b, 8a. Só `docs/`, `perf/`, `security/`.
- **Critérios de aceite**: runbooks revisados pela sessão principal; roteiro k6 roda localmente contra `vercel dev`/mock.

## Onda 6b — Hardening & operação

- **Objetivo**: pronto para tráfego pago real.
- **Escopo**: Vercel Firewall como código (regra de rate limit em `/v1/leads`, bloqueio de métodos ≠ POST/OPTIONS, challenge em Attack Mode), migration de retenção (`pg_cron` + funções `SECURITY DEFINER` de expurgo e `crm.anonymize_lead`), alertas (bot failures, 5xx, outbox lag > 10 min, deliveries dead), execução de k6 e ZAP no preview.
- **Depende de / paralela com**: 5b, 6a / 7b, 8a.
- **Critérios de aceite**: AC-LC-19; ZAP baseline sem alertas High/Medium; pgTAP do expurgo (IP/UA nulos após 30 dias simulados) e de `crm.anonymize_lead`; alertas disparam em teste sintético.
- **Goal command**: `/goal k6 run perf/lead-capture.js passes thresholds p95<800ms and 0% 5xx on preview, zap-baseline reports 0 High/Medium, supabase test db passes retention tests, stop after 6 tries`

## Onda 7a — LP contra mock (Codex)

- **Objetivo**: landing page estática de alta conversão no Cloudflare Pages com o formulário, desenvolvida contra mock.
- **Escopo**: `apps/lp/` conforme [lead-capture §10](../specs/lead-capture.md#10-handoff-para-o-front-codex--wave-7), mock da API via Prism sobre `contracts/openapi.v1.yaml`, `_headers` com CSP de [tracking §7](../specs/tracking.md#7-front-tags-e-csp-wave-8-codex--gtm), banner de consentimento, página de Política de Privacidade versionada.
- **Depende de / paralela com**: 0 / 1–6.
- **Critérios de aceite**: Lighthouse ≥ 90 (performance, acessibilidade, best practices) mobile; erros 400/403/429 do mock exibem mensagens pt-BR por `code`; `turnstile.reset()` após erro; retentativa reutiliza `Idempotency-Key`; zero violações de CSP.

## Onda 7b — LP integrada (Codex)

- **Escopo**: apontar a LP para o preview da API (URL no `NOTES.md`), Turnstile real com chaves de teste.
- **Depende de / paralela com**: 4, 7a / 5b, 6, 8a.
- **Critérios de aceite**: envio real para o preview retorna 202; demais critérios da 7a mantidos.
- **Goal command**: `/goal lighthouse mobile scores >=90 for performance/accessibility/best-practices and a Playwright test submits the form to the preview API receiving 202 and shows pt-BR errors for 400/429 with zero CSP violations, stop after 8 tries`

## Onda 8a — Container GTM (sem publicar)

- **Escopo**: workspace GTM com tags, triggers e variáveis de [tracking §3](../specs/tracking.md#3-contrato-do-datalayer), Consent Mode v2. **Nada publicado.**
- **Depende de / paralela com**: 0 / 5b, 6, 7b.
- **Critérios de aceite**: preview do workspace mostra as tags esperadas por evento do dataLayer; nenhuma tag Custom HTML.

## Onda 8b — Publicação e QA do tracking client-side

- **Objetivo**: funil medido em GA4/Ads/Meta com dedup Pixel×CAPI e consentimento.
- **Escopo**: publicação versionada do container (confirmação humana), QA headless.
- **Depende de / paralela com**: 5b, 7b, 8a / 9b.
- **Critérios de aceite**: AC-TR-08..10; Meta Events Manager mostra `Lead` deduplicado (browser + server) em ≥ 90% dos testes.
- **Goal command**: `/goal Playwright QA intercepting network passes AC-TR-08, AC-TR-09 and AC-TR-10 on the Cloudflare Pages preview, stop after 6 tries`

## Onda 9a — Contrato do CRM

- **Objetivo**: API-first: contrato `/v1/crm/*` fechado antes do código e da UI.
- **Escopo**: rotas de [crm §7](../specs/crm.md#7-api-do-crm-wave-9--esboço-contrato-definitivo-no-openapi-na-abertura-da-wave) no OpenAPI (bump de versão + nota de compatibilidade), threat model staff auth (JWT/JWKS, AAL2, BOLA, CSV injection).
- **Depende de / paralela com**: 0 / 1–8. Escritor único do OpenAPI enquanto aberta.
- **Critérios de aceite**: `redocly lint` 0 erros; toda rota com `security` declarado e papéis em `x-roles`; revisão da sessão principal.

## Onda 9b — CRM API

- **Objetivo**: vendedores trabalham o pipeline com segurança (auth, authz, auditoria, LGPD).
- **Escopo**: migration `core.workspace_members`, verificação de JWT (JWKS, `jose`), middleware de authz por papel, rotas do contrato 9a, export CSV seguro, DSR (export/anonimizar preview-first usando `crm.anonymize_lead`).
- **Depende de / paralela com**: 6b (`crm.anonymize_lead` + sequência em `apps/api`), 9a / 8b.
- **Critérios de aceite**: AC-CRM-06..09; teste cross-tenant e de papel para **cada** rota; token com `alg` fora da allowlist, `aud` errado ou expirado → 401.
- **Goal command**: `/goal pnpm --filter api test:integration passes AC-CRM-06..09 plus authz matrix tests for every /v1/crm route and JWT negative tests (alg, aud, exp), redocly lint 0 errors, stop after 8 tries`

## Onda 10 — CRM web (Codex)

- **Objetivo**: UI do pipeline (kanban), detalhe do lead, notas, filtros, export.
- **Escopo**: `apps/crm-web/` consumindo só a API (nunca o Supabase direto para dados), login Supabase Auth + MFA para admin, CSP restritiva, sem `dangerouslySetInnerHTML`. Começa contra mock Prism do contrato 9a.
- **Depende de / paralela com**: 9a (mock) · 9b (integração) / 11b.
- **Critérios de aceite**: e2e dos fluxos login → mover estágio → nota → export (admin com MFA); lead com `<script>` no nome/mensagem renderiza como texto.
- **Goal command**: `/goal Playwright e2e for login, stage change, note and admin export passes and XSS payload fixture renders as plain text, stop after 8 tries`

## Onda 11a — Preparação da inteligência

- **Escopo**: eval set de qualificação (≥ 30 leads sintéticos com rótulo humano de `fit`, incluindo fixtures de prompt injection) em `apps/api/test/evals/`, threat model com OWASP LLM/Agentic Top 10 em `docs/security/threats/intelligence.md`.
- **Depende de / paralela com**: 0 / 1–9. Só arquivos novos.
- **Critérios de aceite**: rótulos revisados pelo dono do projeto; nenhum dado real de lead no eval set.

## Onda 11b — Inteligência

- **Objetivo**: qualificação por IA, automações internas e retorno de qualidade para ads.
- **Escopo**: [crm §8](../specs/crm.md#8-inteligência-wave-11--esboço); migration `crm.lead_insights`; eval set da 11a rodado antes de ligar.
- **Depende de / paralela com**: 9b, 11a / 10.
- **Critérios de aceite**: AC-CRM-10; eval com ≥ 80% de concordância com rótulo humano em `fit`; orçamento diário respeitado (teste com contador); offline conversions `qualified`/`won` chegam ao Meta Test Events.
- **Goal command**: `/goal pnpm --filter api test src/modules/intelligence passes including AC-CRM-10 and prompt-injection fixtures, and eval script reports fit agreement >=0.8, stop after 8 tries`

## Notas de execução

- Ondas da sessão principal rodam uma branch/PR por onda (`feat/wave-N-<slug>`, squash merge, Conventional Commits).
- Uma onda pode rodar como **goal loop**: invoque o Goal command dela e deixe o avaliador manter a sessão presa
  aos critérios de aceite em vez de confiar em "parece pronto". Feche a onda com a skill `verify` antes de marcá-la como ✅.
- **Subagents Claude** (Sonnet, esforço xhigh) rodam em worktrees isoladas (`isolation: worktree`), uma onda por agent.
  O `.env.local` não existe nas worktrees: subagents trabalham só com fakes/MSW e nunca executam ações externas.
  Merge um PR por vez (ordem sugerida do grupo 1∥2∥3: 1, 3, 2).
- **Codex (GPT)** roda as ondas de front (7, 8, 10) em worktree própria via `codex exec`, consumindo só o contrato
  e o `AGENTS.md`.
- Ondas paralelas não alteram ports, `package.json`/lockfile, `platform/config`, `src/index.ts` nem o OpenAPI
  (exceto a 9a). Se precisarem, param e a mudança vira PR separado antes.
- Quando uma onda terminar, marque-a como ✅ aqui E no `NOTES.md`, e então atualize o
  status atual do `NOTES.md` antes de encerrar a sessão.
