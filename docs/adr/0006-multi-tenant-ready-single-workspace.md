# ADR-0006 — Modelo multi-tenant ready (`workspace_id` + RLS), operando um workspace

- Status: proposed (aguarda confirmação do dono do produto)
- Data: 2026-11-03

## Context

Hoje o CRM atende uma empresa. Há chance real de o mesmo produto atender clientes da
agência no futuro. Adicionar tenancy depois exige migration de todas as tabelas, reescrita
de queries e revisão de toda autorização — caro e arriscado.

## Decision

- Toda tabela de negócio tem `workspace_id NOT NULL` e política RLS por workspace desde a wave 1.
- O workspace é derivado **server-side**: no fluxo público, do `form_key` (roteamento); no CRM,
  da membership do usuário autenticado. Nunca de parâmetro do cliente.
- v1 opera com um único workspace semeado; não há UI de criação de workspace.

## Consequences

- (+) Isolamento testado desde o início (AC-DB-03, AC-CRM-06); virar SaaS não exige migração estrutural.
- (−) Pequeno custo extra em cada query/índice e no setup de transação (`set_config`).
