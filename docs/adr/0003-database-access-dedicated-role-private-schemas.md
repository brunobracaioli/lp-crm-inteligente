# ADR-0003 — Acesso ao Postgres por role dedicada, schemas privados e RLS deny-by-default

- Status: accepted
- Data: 2026-11-03

## Context

O caminho padrão do Supabase (supabase-js + chave secreta/service_role via Data API) dá ao
runtime privilégio total e ignora RLS. O endpoint público de leads é o principal alvo de
ataque; um bug nele não pode significar acesso irrestrito ao banco. A spec exige defesa
estrutural contra SQL Injection e least privilege.

## Decision

- Tabelas em schemas privados por contexto (`core`, `crm`, `capture`, `tracking`), **não expostos** pela Data API.
- Runtime conecta via Supavisor (transaction mode) com a role **`lp_api`**: sem DDL, sem `DELETE`,
  sem `BYPASSRLS`, `statement_timeout` 3 s, `search_path` vazio, TLS `verify-full`.
- RLS `ENABLE` + `FORCE` em todas as tabelas; isolamento por `app.workspace_id` definido por transação.
- Driver `postgres` (porsager) apenas com tagged templates (queries parametrizadas); `sql.unsafe` proibido por Semgrep.
- A chave secreta do Supabase **não** é usada pela API. Migrations rodam pela CLI (role `postgres`) só em dev/CI.
- Senha da `lp_api` definida fora das migrations e guardada como env var na Vercel.

## Consequences

- (+) Um SQLi ou RCE no runtime fica confinado a INSERT/SELECT/UPDATE no workspace corrente.
- (+) Sem PostgREST exposto para esses dados → superfície menor.
- (−) Não usamos os helpers do supabase-js para dados; o CRM web (wave 10) acessa via nossa API, não direto.
- (−) Operação a mais: criar/rotacionar a senha da role (how-to dedicado).
