# Referência — Schema do banco (wave 1)

> Derivado de [database.md](../specs/database.md) §1–5 e da migration
> `supabase/migrations/20261103220000_core_schema.sql` (que prevalece em caso de divergência). Conferido
> contra o catálogo do Postgres 17 local. Migrations são imutáveis: mudança de schema = nova migration e
> atualização deste documento no mesmo PR.

## Como aplicar e verificar

```bash
supabase start                 # sobe a stack local (portas 547xx, ver supabase/config.toml)
supabase db reset              # recria o banco, aplica migrations e supabase/seed.sql
supabase test db               # pgTAP: supabase/tests/*.test.sql (AC-DB-01..10)
supabase db lint               # plpgsql_check nos schemas do app
supabase stop
```

`supabase/seed.sql` roda **só** no `db reset` local e nunca em projeto hospedado.

## Schemas e acesso

| Schema | Contexto | Exposto na Data API? |
|---|---|---|
| `core` | workspaces, forms, audit log | não |
| `crm` | leads e timeline | não |
| `capture` | submissões e consentimentos | não |
| `tracking` | outbox e entregas | não |
| `public` | vazio (AC-DB-10) | **sim** — `[api] schemas = ["public"]` |

- `anon`, `authenticated` e `service_role` não têm `USAGE` em nenhum schema privado (nem `SELECT` em tabela).
- A API acessa o banco **somente** pela role `lp_api` (ADR-0003). `service_role`/chave secreta não são usadas.
- O hosted precisa dos mesmos ajustes do `config.toml` (`jwt_expiry = 900`, sign-up desligado, Data API só com
  `public`): `supabase config push` ou painel. O `config.toml` só governa a stack local.

## Role `lp_api`

| Atributo | Valor |
|---|---|
| Login | sim, **sem senha na migration** (ver [rotate-db-role-password](../how-to/rotate-db-role-password.md)) |
| `NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE`, não superuser/replication | sim |
| `CONNECTION LIMIT` | 20 |
| `statement_timeout` / `idle_in_transaction_session_timeout` | `3s` / `5s` |
| `search_path` | vazio — todo objeto é referenciado com schema |
| Membro de outras roles | nenhuma |

Privilégios (allow-list exata, verificada por pgTAP; nenhuma tabela tem `DELETE`, `TRUNCATE`, `REFERENCES`,
`TRIGGER` para `lp_api`):

| Tabela | Privilégios |
|---|---|
| `core.workspaces`, `core.forms` | `SELECT` |
| `core.audit_log`, `crm.lead_activities`, `capture.consents` | `SELECT`, `INSERT` (append-only) |
| `crm.leads`, `tracking.outbox_events`, `tracking.deliveries` | `SELECT`, `INSERT`, `UPDATE` |
| `capture.submissions` | `SELECT`, `INSERT`, `UPDATE (client_ip, user_agent, pii_purged_at)` |

Função: `EXECUTE` em `core.current_workspace_id()` (usada pelas policies). Expurgo e anonimização em massa
rodam como funções `SECURITY DEFINER` (wave 6), não pelo runtime.

## Isolamento por workspace (RLS)

Todas as tabelas têm `ENABLE` + `FORCE ROW LEVEL SECURITY`. A aplicação executa, no início de cada transação:

```sql
SELECT set_config('app.workspace_id', $1, true);   -- escopo da transação
```

`core.current_workspace_id()` lê esse valor com `NULLIF(current_setting('app.workspace_id', true), '')::uuid`:
ausente **ou vazio** → `NULL` → nenhuma linha. O `NULLIF` é necessário porque, numa conexão reaproveitada pelo
pooler, o setting volta como `''` (não `NULL`) depois do commit e `''::uuid` lançaria erro. Valor malformado
(não-UUID) falha fechado com erro `22P02`.

| Tabela | Policies (todas `TO lp_api`) |
|---|---|
| `core.workspaces` | `SELECT` onde `id = core.current_workspace_id()` |
| `core.forms` | `SELECT` onde `status = 'active'` — **sem filtro de workspace** (roteamento público por `form_key`) |
| `core.workspace_members` (9b) | `SELECT` onde `workspace_id = core.current_workspace_id()` **ou** (`active` e `user_id = core.current_staff_user_id()`, setting `app.staff_user_id`, só no lookup de membership) |
| `crm.leads`, `capture.submissions`, `tracking.outbox_events`, `tracking.deliveries` | `SELECT`, `INSERT` (`WITH CHECK`), `UPDATE` (`USING` + `WITH CHECK`) por `workspace_id` |
| `capture.consents`, `crm.lead_activities`, `core.audit_log` | `SELECT`, `INSERT` (`WITH CHECK`) por `workspace_id` |

Uma policy por comando (não `FOR ALL`): um `GRANT` futuro de `DELETE` não abre acesso por acidente.

## Tabelas

Convenções: `uuid` v7 gerado pela aplicação (sem default); `timestamptz`; todo `CHECK` passa com `NULL`
(coluna anulável não precisa de guarda). Enums são `text` + `CHECK` (vocabulários de
`apps/api/src/shared/lead-profile.ts` e `modules/crm/domain/lead-types.ts`).

### `core.workspaces`

| Coluna | Tipo | Null | Default / regra |
|---|---|---|---|
| `id` | uuid | não | PK |
| `slug` | text | não | `UNIQUE`; `^[a-z0-9-]{3,40}$` |
| `name` | text | não | 1–120 |
| `settings` | jsonb | não | `'{}'`; objeto JSON (ICP e pesos do score, validado por Zod na app) |
| `created_at`, `updated_at` | timestamptz | não | `now()`; `updated_at` por trigger |

### `core.workspace_members` (wave 9b)

Migration `20261104110000_workspace_members.sql`. Detalhes e justificativa do desenho em
[database §3.10](../specs/database.md#310-coreworkspace_members-wave-9b--migration-20261104110000_workspace_memberssql).

| Coluna | Tipo | Null | Default / regra |
|---|---|---|---|
| `workspace_id` | uuid | não | PK (com `user_id`); FK → `core.workspaces(id)` |
| `user_id` | uuid | não | `sub` do token; referência lógica a `auth.users`, sem FK |
| `display_name` | text | não | 1–80, sem controles/zero-width/bidi, sem espaços nas pontas |
| `role` | text | não | `owner`, `admin`, `sales`, `viewer` |
| `active` | boolean | não | `true` |
| `created_at` | timestamptz | não | `now()` |

`lp_api` só tem `SELECT`; a tabela é provisionada fora da API. Índice parcial `(user_id) WHERE active`.

### `core.forms`

| Coluna | Tipo | Null | Default / regra |
|---|---|---|---|
| `id` | uuid | não | PK |
| `workspace_id` | uuid | não | FK `core.workspaces` |
| `form_key` | text | não | `UNIQUE`; `^frm_[a-z0-9_]{3,40}$` (identificador público) |
| `name` | text | não | 1–120 |
| `status` | text | não | `'active'`; `active`, `paused`, `archived` |
| `allowed_origins` | text[] | não | cada item `https://host[:porta]` (minúsculas) **ou** `http://localhost` / `http://127.0.0.1` `[:porta]` (dev), via `core.is_valid_origin_list` |
| `turnstile_action` | text | não | `'lead_submit'`; `^[a-z0-9_]{1,32}$` |
| `privacy_policy_version` | text | não | `^[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[0-9]+)?$` |
| `created_at`, `updated_at` | timestamptz | não | `now()`; `updated_at` por trigger |

### `crm.leads`

| Coluna | Tipo | Null | Default / regra |
|---|---|---|---|
| `id` | uuid | não | PK |
| `workspace_id` | uuid | não | FK `core.workspaces` |
| `first_name`, `last_name` | text | não | 1–60 / 1–80 |
| `email` | text | não | ≤ 254; minúsculas; `^[^@\s]+@[^@\s]+\.[^@\s]+$` |
| `whatsapp_e164` | text | não | `^\+[1-9][0-9]{7,14}$` |
| `company_name` | text | não | 2–120 |
| `area_of_expertise` | text | não | enum de 17 códigos (lead-capture §4.2) |
| `area_of_expertise_other` | text | sim | 2–80; presente **se e somente se** área = `other` |
| `job_title` | text | sim | 2–100 |
| `company_size` | text | sim | `solo`, `2_10`, `11_50`, `51_200`, `201_1000`, `1000_plus` |
| `company_website` | text | sim | ≤ 200; `^https?://` |
| `stage` | text | não | `'new'`; `new`, `contacted`, `qualified`, `proposal`, `won`, `lost` |
| `lost_reason` | text | sim | 8 motivos (crm §4); presente **se e somente se** `stage = 'lost'` |
| `score` | smallint | não | `0`; 0–100 |
| `score_band` | text | não | `'C'`; `A`, `B`, `C` |
| `score_breakdown` | jsonb | não | `'[]'`; array JSON |
| `owner_user_id` | uuid | sim | referência lógica a `auth.users` (wave 9), sem FK |
| `marketing_opt_in` | boolean | não | `false` |
| `submissions_count` | integer | não | `1`; ≥ 1 |
| `first_touch`, `last_touch` | jsonb | não | `'{}'`; objeto JSON (atribuição) |
| `first_submitted_at`, `last_submitted_at` | timestamptz | não | — |
| `anonymized_at` | timestamptz | sim | LGPD; sai do índice único de e-mail |
| `version` | integer | não | `1`; ≥ 1; lock otimista (`WHERE version = expected`, depois `+ 1`) |
| `created_at`, `updated_at` | timestamptz | não | `now()`; `updated_at` por trigger |

Índices: `leads_workspace_email_active_key` (UNIQUE `(workspace_id, email) WHERE anonymized_at IS NULL`, alvo
do `ON CONFLICT`), `leads_workspace_id_id_key` (UNIQUE `(workspace_id, id)`, alvo das FKs compostas),
`leads_pipeline_idx`, `leads_owner_stage_idx`, `leads_whatsapp_idx`, `leads_score_band_idx`.

### `capture.submissions`

| Coluna | Tipo | Null | Default / regra |
|---|---|---|---|
| `id` | uuid | não | PK |
| `workspace_id` | uuid | não | FK `core.workspaces` |
| `form_id`, `lead_id` | uuid | não | FKs compostas `(workspace_id, form_id)` → `core.forms` e `(workspace_id, lead_id)` → `crm.leads` |
| `idempotency_key` | uuid | não | `UNIQUE (workspace_id, idempotency_key)` |
| `request_hash` | text | não | SHA-256 hex, 64 caracteres |
| `event_id` | uuid | não | `UNIQUE (workspace_id, event_id)` (dedup Pixel × CAPI) |
| `fields` | jsonb | não | objeto JSON (snapshot normalizado) |
| `message` | text | sim | ≤ 1000 |
| `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `utm_id` | text | sim | ≤ 150 cada |
| `gclid`, `gbraid`, `wbraid`, `fbclid`, `ttclid`, `msclkid` | text | sim | ≤ 500 cada |
| `fbp`, `fbc` | text | sim | ≤ 500 |
| `ga_client_id` | text | sim | ≤ 100 |
| `landing_page_url`, `referrer_url` | text | sim | ≤ 2000 |
| `consent_state` | jsonb | não | objeto com as 4 chaves `analytics_storage`, `ad_storage`, `ad_user_data`, `ad_personalization`, cada uma `granted`/`denied` |
| `client_ip` | inet | sim | **PII; expurgado em 30 dias** |
| `user_agent` | text | sim | ≤ 512; **PII; expurgado em 30 dias** |
| `ip_hmac` | text | não | HMAC-SHA256 hex (64) do IP |
| `antibot` | jsonb | não | objeto JSON |
| `pii_purged_at` | timestamptz | sim | se preenchido, `client_ip` e `user_agent` são `NULL` |
| `created_at` | timestamptz | não | `now()` |

Índices: `submissions_workspace_id_id_key` UNIQUE `(workspace_id, id)` (alvo da FK composta de `consents`),
`submissions_lead_created_idx` `(lead_id, created_at DESC)`, `submissions_pii_purge_idx`
`(created_at) WHERE pii_purged_at IS NULL`.

### `capture.consents` (append-only)

`id`, `workspace_id` (FK `core.workspaces`), `lead_id`, `submission_id` (FKs compostas com `workspace_id`),
`purpose` (`privacy_policy`, `marketing_communications`,
`ad_tracking`), `granted`, `policy_version` (mesmo formato de `forms`), `created_at`. Índice
`consents_lead_purpose_idx` `(lead_id, purpose, created_at DESC)`.

### `crm.lead_activities` (append-only)

`id`, `workspace_id` (FK `core.workspaces`), `lead_id` (FK composta com `workspace_id`), `type` (8 tipos de database §3.6), `actor_type` (`system`, `user`, `ai`),
`actor_id` (anulável), `data` (objeto JSON ≤ 8 KB, só IDs e códigos), `created_at`. Índice
`lead_activities_lead_created_idx` `(lead_id, created_at DESC)`.

### `tracking.outbox_events`

`id`, `workspace_id`, `aggregate_type` (`lead`), `aggregate_id`, `event_type` (`lead.captured`,
`lead.stage_changed`), `payload` (objeto JSON, **sem PII**), `status` (`pending` default, `processing`, `done`,
`dead`), `attempts` (≥ 0), `next_attempt_at` (`now()`), `locked_until`, `created_at`, `processed_at`. Índices:
`outbox_events_workspace_id_id_key` UNIQUE `(workspace_id, id)` (alvo da FK composta de `deliveries`) e o parcial
`outbox_events_sweeper_idx` `(status, next_attempt_at) WHERE status IN ('pending','processing')`.

### `tracking.deliveries`

`id`, `outbox_event_id` (FK composta `(workspace_id, outbox_event_id)` → `tracking.outbox_events`),
`workspace_id` (FK `core.workspaces`), `destination` (`meta_capi`, `ga4_mp`, `google_ads`,
`ai_qualification`), `status` (`pending` default, `sent`, `skipped_no_consent`, `skipped_disabled`, `failed`,
`dead`), `attempts`, `last_http_status` (100–599), `last_error_code` (≤ 100, código interno), `external_ref`
(≤ 200), `created_at`, `updated_at` (trigger). `UNIQUE (outbox_event_id, destination)`.

### `core.audit_log` (append-only)

`id` (`bigint GENERATED ALWAYS AS IDENTITY`), `workspace_id`, `occurred_at` (`now()`), `actor_type` (`system`,
`user`, `qstash`, `ai`), `actor_id`, `action` (1–100), `resource_type` (1–50), `resource_id` (anulável),
`result` (`success`, `denied`, `error`), `correlation_id`, `metadata` (objeto JSON ≤ 8 KB, sem PII). Índice
`audit_log_workspace_occurred_idx` `(workspace_id, occurred_at DESC)`.

## Garantias de integridade

- **Referências seguras entre tenants**: toda FK entre tabelas com `workspace_id` é composta —
  `(workspace_id, <pai>_id)` → `<pai> (workspace_id, id)` — e todo pai referenciado tem
  `UNIQUE (workspace_id, id)` (`forms`, `leads`, `submissions`, `outbox_events`). As verificações de FK ignoram
  RLS, então esta é a única barreira contra um filho do workspace B apontar para um pai do workspace A; um pai com
  filhos também não pode mudar de workspace. Violação → `foreign_key_violation` (`23503`). As FKs simples
  restantes são só `workspace_id` → `core.workspaces (id)`. FKs nomeadas: `submissions_form_fkey`,
  `submissions_lead_fkey`, `consents_lead_fkey`, `consents_submission_fkey`, `lead_activities_lead_fkey`,
  `deliveries_outbox_event_fkey`. Novas migrations devem seguir o mesmo padrão (um teste de catálogo em `001`
  falha se surgir FK entre tabelas de workspace que não seja composta).
- **Append-only**: `capture.consents`, `crm.lead_activities` e `core.audit_log` têm trigger
  `BEFORE UPDATE OR DELETE` (por linha) e `BEFORE TRUNCATE` que lançam `restrict_violation` (`23001`) — vale
  até para o dono da tabela. Para `lp_api` a primeira barreira é a ausência de privilégio (`42501`).
- `updated_at` é sempre `now()` da transação (o chamador não consegue sobrescrever).
- Funções do schema `core` (`current_workspace_id`, `set_updated_at`, `reject_mutation`,
  `is_valid_origin_list`) têm `search_path` vazio e `EXECUTE` revogado de `PUBLIC`.

## Decisões e desvios em relação à spec

1. **`core.current_workspace_id()` com `NULLIF`** em vez de `current_setting(...)::uuid` direto nas policies
   (motivo acima). Comportamento da spec preservado: sem workspace, nenhuma linha.
2. **Origins de dev**: a spec pede `^https://…`, mas o seed e a LP local precisam de `http://localhost`. O CHECK
   aceita `https` (qualquer host) **ou** `http` somente para `localhost`/`127.0.0.1`. Em produção basta não
   cadastrar origins de loopback.
3. **CHECKs adicionais** (defesa em profundidade, não listados na spec): tipo JSON (`settings`, `fields`,
   `antibot`, `first_touch`, `last_touch` objetos; `score_breakdown` array), forma de `consent_state`,
   consistência de `pii_purged_at` com `client_ip`/`user_agent`, `ip_hmac` e `request_hash` em hex de 64,
   limites de tamanho em `audit_log`/`deliveries`.
4. **Guarda de `TRUNCATE`** nas três tabelas append-only (a spec só cita `UPDATE`/`DELETE`).
5. **FKs compostas por tenant** (pedido da revisão da wave 1): a spec descreve FKs simples; a migration usa
   `(workspace_id, id)` para impedir referências entre workspaces (ver "Garantias de integridade").
6. **Defaults de conveniência**: `score = 0`, `score_band = 'C'`, `score_breakdown = '[]'`,
   `submissions_count = 1`, `version = 1`, `first_touch/last_touch = '{}'`, `marketing_opt_in = false`.
7. **Retenção (wave 6b)**: o trigger append-only de `core.audit_log` também bloqueia o `DELETE` mensal de 12
   meses previsto em database §6. A wave 6b precisa de uma exceção explícita (por exemplo, função
   `SECURITY DEFINER` dedicada que o trigger reconheça) — decisão a registrar em ADR naquela onda.
8. `lp_api` herda `USAGE` em `public` via `PUBLIC` (padrão do Postgres/Supabase); como `public` não tem
   objetos (AC-DB-10) e `lp_api` não tem `CREATE`, não há acesso efetivo.

## Cobertura dos critérios de aceite

| AC | Arquivo pgTAP |
|---|---|
| AC-DB-01 | `supabase/tests/003_privileges.test.sql` (+ catálogo em `001`) |
| AC-DB-02, AC-DB-03 | `supabase/tests/002_rls_isolation.test.sql` |
| AC-DB-04, AC-DB-05 | `supabase/tests/003_privileges.test.sql` |
| AC-DB-06, AC-DB-07, AC-DB-08 | `supabase/tests/004_constraints.test.sql` |
| AC-DB-09 (RLS), AC-DB-10 | `supabase/tests/001_schema_posture.test.sql`; o lint é `supabase db lint` |
| Carga real do `POST /v1/leads` e do sweeper como `lp_api` | `supabase/tests/005_runtime_workload.test.sql` |
| FKs compostas (filho do workspace B → pai do A: submissions→leads/forms, consents→submissions/leads, activities→leads, deliveries→outbox, mover pai com filhos) e teste de catálogo "toda FK entre tabelas de workspace é composta" | `supabase/tests/006_tenant_safe_foreign_keys.test.sql` e `001_schema_posture.test.sql` |

AC-DB-07 verifica o resultado de dois `INSERT … ON CONFLICT` em sequência; a corrida real entre duas
transações simultâneas é coberta pelo teste de integração da wave 4 (AC-LC-04).
