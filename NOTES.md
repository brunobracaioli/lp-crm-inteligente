# NOTES — LP + CRM Inteligente

## Current status

- 2026-11-03 — Spec-Driven Development do projeto escrito (specs, ADRs 0001–0006, contrato OpenAPI v1,
  threat model, plano de waves). Plano de ondas revisado para paralelismo (sub-ondas a/b).
- 2026-11-03 — **Onda 0** ✅ concluída (PR #1, branch `feat/wave-0-foundation`): gates locais e CI verdes (lint,
  typecheck, 28 testes, build, redocly 0 erros, Semgrep, gitleaks, osv-scanner — run 41740888803).
  Decisões de toolchain em ADR-0007 (alias `#/`, TS 6, boundaries por lint). Contrato → `1.0.0-draft.2` (`not_found`).
  Risco aceito: minimatch (dev, moderate) em `osv-scanner.toml` até 2027-01-31.
- 2026-11-03 — PR #1 mergeado. Ondas **1, 2, 3, 5a, 9a, 11a** em andamento em paralelo (subagents Sonnet xhigh, worktrees isoladas;
  só backend hoje — 7a fica para o Codex). Onda 1 sem Supabase CLI instalada: `db reset`/`test db` pendentes de execução.
- 2026-11-03 — Gates locais ativos (pre-commit/commit-msg/pre-push + guard de agentes), parte da Onda 0:
  `docs/how-to/local-quality-gates.md`. Subagent `.claude/agents/web-researcher.md` criado.
- Credenciais sendo colocadas em `.env.local` pelo dono (template em `docs/reference/environment.md`).
- Preview da API para o Codex: _a definir na onda 4_.

### Roadmap (espelho de `docs/plan/implementation-waves.md`)

| Onda | Entrega | Status |
|------|---------|--------|
| 0 | Fundação (monorepo, platform kernel, CI de segurança, ports, env 0–5, deps 1–5) | ✅ |
| 1 | Banco: schemas, role `lp_api`, RLS, pgTAP | 🟡 em andamento |
| 2 | Domínio + use case `SubmitLead` | 🟡 em andamento |
| 3 | Adapters Turnstile / Upstash | 🟡 em andamento |
| 4 | Slice `POST /v1/leads` + preview | ⬜ |
| 5a | Tracking isolado (domínio, CAPI client, assinatura QStash) | 🟡 em andamento |
| 5b | Tracking wiring (outbox, rotas internas, sweeper) | ⬜ |
| 6a | Hardening sem conflito (runbooks, k6, ZAP) | ⬜ |
| 6b | Hardening & operação (retenção, `anonymize_lead`, Firewall, alertas) | ⬜ |
| 7a | LP contra mock (Codex) | ⬜ |
| 7b | LP integrada ao preview (Codex) | ⬜ |
| 8a | Container GTM sem publicar | ⬜ |
| 8b | Publicação GTM + QA headless | ⬜ |
| 9a | Contrato `/v1/crm/*` + threat model staff | 🟡 em andamento |
| 9b | CRM API | ⬜ |
| 10 | CRM web (Codex) | ⬜ |
| 11a | Preparação IA (eval set, threat model LLM) | 🟡 em andamento |
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
