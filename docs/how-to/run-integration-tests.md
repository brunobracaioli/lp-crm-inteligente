# Como rodar a suíte de integração (Postgres real)

Os testes de `apps/api/test/integration/` exercitam os adapters Postgres, a `PostgresUnitOfWork`, o RLS e o
`SubmitLead` completo contra um banco **local**. Eles nunca falam com um banco remoto: a suíte recusa qualquer
URL cujo host não seja `127.0.0.1`, `localhost` ou `::1`.

## Pré-requisitos

- Docker em execução (no WSL, ative a integração do Docker Desktop com a distro).
- Supabase CLI instalada (`supabase --version`).
- Uma stack local por máquina (portas do `supabase/config.toml`; o Postgres usa `54722`). Não rode a suíte
  enquanto outra sessão usa a mesma stack: os arquivos compartilham o banco.

## Sem Docker: Postgres 18 descartável

Em máquinas sem Docker (sem `supabase start`), use `scripts/local-db/throwaway-postgres.sh`: um cluster Postgres 18
em diretório descartável, só em loopback, autenticação `trust`, sem segredos.

```bash
export PGDATA_DIR=/tmp/lp-pg PGPORT=54731
scripts/local-db/throwaway-postgres.sh up      # initdb (1ª vez) + start + roles anon/authenticated/service_role
scripts/local-db/throwaway-postgres.sh reset   # recria o banco, aplica supabase/migrations/*.sql, define a senha de lp_api
TEST_DATABASE_URL=postgresql://lp_api:lp_api_local_test@127.0.0.1:54731/postgres \
TEST_ADMIN_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54731/postgres \
  pnpm --filter api test:integration
scripts/local-db/throwaway-postgres.sh down
```

### pg_cron e pgTAP localmente

A migration da wave 6b **exige** `pg_cron` (`CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog` e
`cron.schedule(...)`), sem fallback condicional: no Supabase (hospedado ou `supabase start`) a extensão existe,
e se faltar a migration falha alto em vez de entregar uma retenção que nunca roda.

O cluster descartável não tem `pg_cron`. Em vez de tornar a migration condicional, `up` aponta
`extension_control_path` (Postgres 18) para `scripts/local-db/pg_cron_stub/`, uma extensão **de mesmo nome** que só
registra os jobs em `cron.job` e nunca os executa. A migration roda idêntica à de produção e os testes leem
`cron.job`. Os jobs em si são exercitados chamando as funções diretamente (`retention.test.ts`).

O cluster também não tem pgTAP: `supabase/tests/*.test.sql` só rodam com `supabase test db`. Os testes de retenção e
anonimização têm espelho em Vitest (`retention.test.ts`, `anonymize-lead.test.ts`) justamente para rodar aqui.

## Passos

1. Suba a stack e aplique migrations + seed:

   ```bash
   supabase start
   supabase db reset
   ```

2. Rode a suíte:

   ```bash
   pnpm --filter api test:integration
   ```

Os testes de unidade (`pnpm --filter api test`) não precisam de banco e **não** incluem esta suíte.

## Conexões

| Variável | Papel | Padrão local (descartável) |
|---|---|---|
| `TEST_DATABASE_URL` | Conecta como `lp_api` (RLS vale, como em produção) | `postgresql://lp_api:lp_api_local_test@127.0.0.1:54722/postgres` |
| `TEST_ADMIN_DATABASE_URL` | Conecta como `postgres`: fixtures, contagens e limpeza | `postgresql://postgres:postgres@127.0.0.1:54722/postgres` |

Os padrões são credenciais de desenvolvimento do banco local do `supabase start`, não segredos. Para outro
banco local (por exemplo um Postgres próprio com a migration aplicada), exporte as duas variáveis.

A role `lp_api` nasce **sem senha** (ADR-0003). No início da suíte, o setup define nela a senha presente em
`TEST_DATABASE_URL` usando a conexão admin, só em banco local. Nunca reutilize esse procedimento em
produção: use `docs/how-to/rotate-db-role-password.md`.

## Como os dados são isolados

- Cada teste cria o **próprio workspace** (e formulário) pela conexão admin; nenhum teste lê linhas de outro.
- Ao final de cada teste, as linhas desses workspaces são removidas. As tabelas append-only rejeitam `DELETE`
  para qualquer role, então a limpeza roda em transação admin com `session_replication_role = 'replica'`. Se
  o admin local não puder alterar esse parâmetro, a limpeza é pulada (o isolamento por workspace continua
  valendo; `supabase db reset` limpa tudo).
- O workspace e o formulário do `seed.sql` não são tocados.

## O que a suíte cobre

| Arquivo | Cobertura |
|---|---|
| `unit-of-work-rls.test.ts` | `set_config` local à transação, commit/rollback, timeout de statement, acesso cross-tenant negado (leitura e escrita), `lp_api` sem `DELETE` |
| `crm-repositories.test.ts` | Round-trip do `Lead`, corrida de `insertIfAbsent`, `FOR UPDATE`, lock otimista, atividades, ICP |
| `lead-capture-repositories.test.ts` | Form lookup, submissão (idempotency key e `event_id` duplicados), consentimentos, outbox, auditoria |
| `submit-lead.integration.test.ts` | AC-LC-01, 04, 09/10 (barreira do banco), 13 (metade do banco), 14 e 18 com `createSubmitLead` e adapters reais |
| `retention.test.ts` | Expurgo de IP/UA (30 dias, lotes, idempotência), outbox (90 dias, só `done`), auditoria (12 meses, guarda append-only), inatividade (24 meses entre workspaces), privilégios (`lp_api` não executa expurgo), `SECURITY DEFINER` + `search_path` vazio, jobs em `cron.job` |
| `anonymize-lead.test.ts` | `crm.anonymize_lead`: `true`/`false`, cross-tenant, idempotência e concorrência, varredura do banco atrás da PII original, notas e payloads, atribuição, e-mail reutilizável (AC-CRM-09), timeline continua append-only |

## Problemas comuns

- `cannot reach the local test database`: a stack não está de pé ou a porta difere. Confira `supabase status`.
- `password authentication failed for user "lp_api"`: `TEST_DATABASE_URL` aponta para um banco onde o admin
  não conseguiu definir a senha; rode `supabase db reset` e tente de novo.
- `permission denied` no admin durante a limpeza: veja a nota de isolamento acima; não é falha dos testes.
