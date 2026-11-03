# ADR-0004 — Transactional outbox no Postgres + Upstash QStash para integrações externas

- Status: accepted
- Data: 2026-11-03

## Context

Cada lead dispara chamadas a terceiros (Meta CAPI, GA4, Google Ads, LLM). Essas APIs
falham, ficam lentas e têm rate limit. Chamar inline atrasaria a resposta e poderia perder
eventos; disparar "fire and forget" após commit perde eventos quando a função morre.

## Decision

- No mesmo commit do lead, gravar `tracking.outbox_events` (só IDs, sem PII).
- Após o commit, publicar no **QStash** (`deduplicationId = outbox_event_id`) dentro de `waitUntil`.
- QStash chama `POST /internal/v1/outbox/dispatch` **assinado**; o handler cria uma `delivery` por destino
  (`UNIQUE(outbox_event_id, destination)`) e só reenvia entregas não concluídas.
- Schedule QStash a cada 5 min (`/internal/v1/outbox/sweep`) republica pendentes órfãos.
- Retenção/expurgo usam `pg_cron` dentro do Postgres (sem chamada de rede).

## Consequences

- (+) Nenhum lead depende da disponibilidade de terceiros; entrega at-least-once com efeito exactly-once por destino.
- (+) Independe do plano de cron da Vercel.
- (−) Endpoints internos públicos na internet → autenticação obrigatória por assinatura (Zero Trust) e testes de assinatura.
- (−) Latência de conversão server-side de alguns segundos (aceitável para CAPI).
