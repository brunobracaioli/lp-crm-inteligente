# AGENTS.md — LP + CRM Inteligente

Instruções para agentes de código (Claude Code, Codex) neste repositório.

## Antes de qualquer tarefa

1. Leia `NOTES.md` (status atual e roadmap) e a onda correspondente em `docs/plan/implementation-waves.md`.
2. A spec é a fonte da verdade: `docs/specs/`. Código que contradiz a spec é bug — ou atualize a spec no mesmo PR.
3. O contrato HTTP é `contracts/openapi.v1.yaml` (API-first). Mudou o contrato? Bump de versão + nota de compatibilidade.
4. Decisões estruturais estão em `docs/adr/`. Nova decisão relevante → novo ADR.

## Stack

- API: TypeScript strict (`erasableSyntaxOnly`), Hono, Node 24, Vercel Functions (região `gru1`) — `apps/api/`.
- Banco: Supabase Postgres, schemas privados `core|crm|capture|tracking`, role `lp_api`, RLS — `supabase/`.
- Upstash Redis (rate limit, idempotência) e QStash (outbox). Cloudflare Turnstile. LP em Cloudflare Pages — `apps/lp/`.

## Regras inegociáveis

- Módulos (`lead-capture`, `crm`, `tracking`, `intelligence`) só se comunicam por `public-api.ts` ou eventos do outbox.
- Rotas finas: guards → use case → resposta. Regra de negócio mora em `domain/`.
- SQL só parametrizado (tagged templates do driver `postgres`). `sql.unsafe` e concatenação são proibidos.
- Toda entrada externa validada com Zod `.strict()` (HTTP, QStash, respostas de terceiros, saída de LLM).
- Nenhum endpoint sem auth, exceto os declarados com `security: []` no OpenAPI (ADR-0005).
- Sem PII em logs, dataLayer, query string ou `localStorage`. Use IDs internos.
- Sem segredos no código. Arquivos `.env*` são editados apenas pelo dono do projeto.
- Front: sem `dangerouslySetInnerHTML`, sem tags Custom HTML no GTM, CSP sem `unsafe-eval`.

## Fluxo de trabalho

- Uma branch/PR por onda (`feat/wave-N-<slug>`), Conventional Commits, squash merge.
- Feche a onda rodando os critérios de aceite dela e marque ✅ no plano **e** no `NOTES.md`.
