# NOTES — LP + CRM Inteligente

## Current status

- 2026-11-03 — Spec-Driven Development do projeto escrito (specs, ADRs 0001–0006, contrato OpenAPI v1,
  threat model, plano de waves). Plano de ondas revisado para paralelismo (sub-ondas a/b).
- 2026-11-03 — **Onda 0** ✅ concluída (PR #1, branch `feat/wave-0-foundation`): gates locais e CI verdes (lint,
  typecheck, 28 testes, build, redocly 0 erros, Semgrep, gitleaks, osv-scanner — run 41740888803).
  Decisões de toolchain em ADR-0007 (alias `#/`, TS 6, boundaries por lint). Contrato → `1.0.0-draft.2` (`not_found`).
  Risco aceito: minimatch (dev, moderate) em `osv-scanner.toml` até 2027-01-31.
- 2026-11-03 — PR #1 mergeado. Ondas **1, 2, 3, 5a, 9a, 11a** implementadas em paralelo (subagents Sonnet xhigh em
  worktrees), revisadas pela sessão principal e integradas localmente sem conflito: `verify.sh full` verde com as 6
  juntas (760 testes, build, redocly). Onda 1 verificada com Supabase CLI 2.120.0 (`test db`: 207 testes; FKs compostas
  por `workspace_id` adicionadas na revisão). Branches locais `feat/wave-{1-database,2-domain,3-edge-adapters,
  5a-tracking,9a-crm-contract,11a-intelligence-prep}` com CI verde nos PRs #3–#8. Ordem de merge: #3 → #4 → #5 → #6 → #7 → #8 → #9.
- 2026-11-04 — **Onda 4** 🟡 código pronto na branch `feat/wave-4-lead-slice` (base local com as ondas 1–3/5a/9a/11a;
  rebase sobre a `main` depois do merge dos PRs #3–#9). Implementada em paralelo (subagents Sonnet high: Postgres e
  HTTP) + composition root na sessão principal. `verify.sh full` verde (880 testes) e `test:integration` 47/47 num
  Postgres 18 local descartável (sem Docker no WSL; falta rodar uma vez no `supabase start`, PG17).
  Pendências da revisão resolvidas: colisão de `event_id` (retry único com id do servidor), `#test/*`, TTL
  `in_progress` de 60 s, `trustVercelProxy` fora de development (IP `null` → bucket `unknown`), Redis com 1 retry,
  queda do banco → `503 service_unavailable` + `Retry-After`. Contrato → `1.0.0-draft.4` (`Retry-After` obrigatório).
  Falta para ✅: deploy de preview + env vars de preview na Vercel (ação externa, exige confirmação do dono) e `curl`
  com chave Turnstile de teste retornando `202`. O outbox fica `pending` até a 5b.
- 2026-11-04 — **Onda 5b** 🟡 código pronto na branch `feat/wave-5b-tracking-wiring` (sobre a 4). App/rotas/repos
  feitos por subagent Sonnet high, wiring na sessão principal. `verify.sh full` verde (967 testes) e
  `test:integration` 85/85 (inclui AC-TR-01/02/04/05/07 com Postgres, cross-tenant e dispatch concorrente).
  Contrato → `1.0.0-draft.5`. ADR-0008 (proposed): leitura somente-leitura de `crm`/`capture` pelo adapter do
  tracking — **decisão do dono**. Novas envs: `DEFAULT_WORKSPACE_ID` (obrigatória fora de dev), `GA4_MP_ENABLED`
  (o template `.env.example` precisa delas; `.env*` é editado só pelo dono). Falta para ✅: preview, aplicar o
  schedule (`apps/api/scripts/qstash-schedules.ts --apply`, ação externa) e AC-TR-01 manual no Meta Test Events.
- 2026-11-04 — **Onda 6a** ✅ (branch `feat/wave-6a-hardening`, sobre a 5b): runbooks (flood, rotação de segredos,
  dead letters), `perf/lead-capture.js` (k6 validado contra Prism local), `security/zap/` (baseline passivo; não
  executado, sem Docker) e revisão do threat model (`backend-v1.md`, N1–N14). N4/N9 já resolvidos na 4/5b; N6
  corrigido (redação de `company`, `job_title`, `company_website`, `hp`, `fields`, `body`).
  **Decisões do dono abertas pela revisão:** N1 — limites de IP (5/10 min) impedem medir AC-LC-19 com k6: perfil de
  limite só no preview ou bypass de teste? N2 — as chaves de teste do Turnstile devolvem `hostname: localhost` e
  `action: test`, que o adapter recusa: o preview usa chaves reais com o hostname do preview (recomendado) ou um
  modo de teste explícito? Para a 6b: N3 (cota por form antes do Turnstile), N5 (prazo total vs `maxDuration`),
  N10 (headers em respostas geradas pela plataforma via `vercel.json`).
- Pendências que continuam para a **9b**: 7 códigos novos do draft.3 em `platform/errors/problem.ts`; CORS separado
  para o CRM web.
- Pendências para **5b / 6b**: `gaClientId` no port de tracking e flag `GA4_MP_ENABLED`; sweeper recebe o
  `workspace_id` (o `lp_api` não enumera workspaces); expurgo de 12 meses do `core.audit_log` conflita com o trigger
  append-only (ADR na 6b); `crm.anonymize_lead` deve cobrir notas, `first_touch`/`last_touch` e `crm.lead_insights`.
- Decisões do dono pendentes (detalhe nos threat models `crm-staff-auth.md` G1–G19 e `intelligence.md` G1–G14):
  normalização de nome para a Meta (spec diz "sem acento", vetor oficial mantém acento — seguido o da Meta);
  UTM/click id malformado → 400 (spec) ou descartar o campo; revisar rótulos do eval set (11a) antes da 11b;
  ICP (Q2); auto-atribuição do `sales` na mudança de estágio; limite de 16 KB vs nota de 5000 caracteres.
- 2026-11-03 — Gates locais ativos (pre-commit/commit-msg/pre-push + guard de agentes), parte da Onda 0:
  `docs/how-to/local-quality-gates.md`. Subagent `.claude/agents/web-researcher.md` criado.
- Credenciais sendo colocadas em `.env.local` pelo dono (template em `docs/reference/environment.md`).
- Preview da API para o Codex: _a definir na onda 4_.

### Roadmap (espelho de `docs/plan/implementation-waves.md`)

| Onda | Entrega | Status |
|------|---------|--------|
| 0 | Fundação (monorepo, platform kernel, CI de segurança, ports, env 0–5, deps 1–5) | ✅ |
| 1 | Banco: schemas, role `lp_api`, RLS, pgTAP | ✅ |
| 2 | Domínio + use case `SubmitLead` | ✅ |
| 3 | Adapters Turnstile / Upstash | ✅ |
| 4 | Slice `POST /v1/leads` + preview | 🟡 código pronto; falta preview |
| 5a | Tracking isolado (domínio, CAPI client, assinatura QStash) | ✅ |
| 5b | Tracking wiring (outbox, rotas internas, sweeper) | 🟡 código pronto; falta preview |
| 6a | Hardening sem conflito (runbooks, k6, ZAP) | ✅ |
| 6b | Hardening & operação (retenção, `anonymize_lead`, Firewall, alertas) | 🟡 Firewall e alertas como código prontos (`feat/wave-6b-ops`); migration de retenção em andamento; k6/ZAP dependem do preview |
| 7a | LP contra mock (Codex) | ⬜ |
| 7b | LP integrada ao preview (Codex) | ⬜ |
| 8a | Container GTM sem publicar | ⬜ |
| 8b | Publicação GTM + QA headless | ⬜ |
| 9a | Contrato `/v1/crm/*` + threat model staff | ✅ |
| 9b | CRM API | 🟡 em andamento (auth do staff, rotas de leitura, escrita e LGPD em paralelo) |
| 10 | CRM web (Codex) | ⬜ |
| 11a | Preparação IA (eval set, threat model LLM) | ✅ |
| 11b | Inteligência (IA, automações, offline conversions) | ⬜ |

Caminho crítico: 0 → {1, 2, 3} → 4 → 5b → 6b → 9b → 11b. Gates sequenciais e regras de paralelismo em
`docs/plan/implementation-waves.md`.

## Questões em aberto

Ver [000-overview §7](docs/specs/000-overview.md#7-questões-em-aberto) (Q1–Q7).

## Mapa de documentos

| Documento | Caminho |
|---|---|
| Visão geral / arquitetura / NFRs | `docs/specs/000-overview.md` |
| Captação de leads (campos, validação, OWASP, aceite, handoff front) | `docs/specs/lead-capture.md` |
| Banco de dados | `docs/specs/database.md` |
| Tracking e atribuição | `docs/specs/tracking.md` |
| CRM e inteligência | `docs/specs/crm.md` |
| Contrato da API | `contracts/openapi.v1.yaml` |
| ADRs | `docs/adr/` |
| Threat model | `docs/security/threats/backend-v1.md` |
| Plano de waves | `docs/plan/implementation-waves.md` |
| Variáveis de ambiente | `docs/reference/environment.md` |
