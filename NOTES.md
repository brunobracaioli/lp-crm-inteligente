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
  5a-tracking,9a-crm-contract,11a-intelligence-prep}`, aguardando push/PR. Ordem de merge: 1 → 3 → 2 → 5a → 9a → 11a.
- Pendências para a **Onda 4** (wiring), vindas das revisões:
  - idempotência: passar `inProgressTtlSeconds ≈ 60` (o default de 24 h bloqueia retentativas após crash);
  - `resolveClientIp(..., { trustVercelProxy: true })` no Vercel e decidir o tratamento de IP `null` (hoje bucket `unknown`);
  - `SubmissionRepository.insert` sem `duplicate_event_id` → colisão de `event_id` vira 500 (propor ajuste no port);
  - `#test/*` em `imports` do `apps/api/package.json` para `test/integration/` alcançar `test/fakes/`;
  - cliente Redis com poucas retentativas (adapters já têm timeout de 1 s); métrica `idempotency.unavailable` proposta;
  - 7 códigos novos do contrato draft.3 em `platform/errors/problem.ts` (9b); CORS separado para o CRM web (9b).
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
| 1 | Banco: schemas, role `lp_api`, RLS, pgTAP | 🟡 implementada, aguarda PR/CI |
| 2 | Domínio + use case `SubmitLead` | 🟡 implementada, aguarda PR/CI |
| 3 | Adapters Turnstile / Upstash | 🟡 implementada, aguarda PR/CI |
| 4 | Slice `POST /v1/leads` + preview | ⬜ |
| 5a | Tracking isolado (domínio, CAPI client, assinatura QStash) | 🟡 implementada, aguarda PR/CI |
| 5b | Tracking wiring (outbox, rotas internas, sweeper) | ⬜ |
| 6a | Hardening sem conflito (runbooks, k6, ZAP) | ⬜ |
| 6b | Hardening & operação (retenção, `anonymize_lead`, Firewall, alertas) | ⬜ |
| 7a | LP contra mock (Codex) | ⬜ |
| 7b | LP integrada ao preview (Codex) | ⬜ |
| 8a | Container GTM sem publicar | ⬜ |
| 8b | Publicação GTM + QA headless | ⬜ |
| 9a | Contrato `/v1/crm/*` + threat model staff | 🟡 implementada, aguarda PR/CI |
| 9b | CRM API | ⬜ |
| 10 | CRM web (Codex) | ⬜ |
| 11a | Preparação IA (eval set, threat model LLM) | 🟡 implementada, aguarda PR/CI |
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
