-- AC-DB-09 (RLS ENABLE + FORCE on every table), AC-DB-10 (public holds no tables) and the structural
-- posture of ADR-0003: lp_api attributes, private schemas, least-privilege grants, commented indexes.
-- Catalog checks only: they also protect tables added by future migrations.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(24);

-- Schemas and role --------------------------------------------------------------------------------

SELECT has_schema('core', 'schema core exists');
SELECT has_schema('crm', 'schema crm exists');
SELECT has_schema('capture', 'schema capture exists');
SELECT has_schema('tracking', 'schema tracking exists');

SELECT results_eq(
  $$ SELECT rolcanlogin, rolsuper, rolbypassrls, rolinherit, rolcreatedb, rolcreaterole, rolreplication, rolconnlimit
     FROM pg_catalog.pg_roles WHERE rolname = 'lp_api' $$,
  $$ VALUES (true, false, false, false, false, false, false, 20) $$,
  'lp_api: LOGIN, NOINHERIT, no SUPERUSER/BYPASSRLS/CREATEDB/CREATEROLE/REPLICATION, connection limit 20'
);

SELECT is(
  (SELECT count(*) FROM pg_catalog.pg_auth_members WHERE member = 'lp_api'::regrole),
  0::bigint,
  'lp_api is a member of no role (inherits nothing)'
);

SELECT set_eq(
  $$ SELECT unnest(setconfig) FROM pg_catalog.pg_db_role_setting WHERE setrole = 'lp_api'::regrole $$,
  $$ VALUES ('statement_timeout=3s'), ('idle_in_transaction_session_timeout=5s'), ('search_path=""') $$,
  'lp_api runs with statement_timeout 3s, idle_in_transaction_session_timeout 5s and an empty search_path'
);

-- AC-DB-09: RLS ENABLE + FORCE on every table ------------------------------------------------------

SELECT cmp_ok(
  (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('core', 'crm', 'capture', 'tracking') AND c.relkind IN ('r', 'p')),
  '>=', 9::bigint,
  'AC-DB-09: the four private schemas hold at least the nine wave-1 tables'
);

SELECT is(
  (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('core', 'crm', 'capture', 'tracking') AND c.relkind IN ('r', 'p')
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity)),
  0::bigint,
  'AC-DB-09: every table has ROW LEVEL SECURITY enabled and forced'
);

SELECT is(
  (SELECT count(*) FROM pg_catalog.pg_policies
   WHERE schemaname IN ('core', 'crm', 'capture', 'tracking') AND roles <> ARRAY['lp_api']::name[]),
  0::bigint,
  'every RLS policy targets lp_api only'
);

-- AC-DB-10: the Data API schema stays empty -----------------------------------------------------------

SELECT is(
  (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')),
  0::bigint,
  'AC-DB-10: schema public (the only schema exposed by the Data API) holds no tables or views'
);

-- Private schemas: deny by default for the Data API roles -----------------------------------------------

SELECT is(
  (SELECT count(*) FROM (VALUES ('core'), ('crm'), ('capture'), ('tracking')) AS s (name)
   CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) AS r (role)
   WHERE pg_catalog.has_schema_privilege(r.role, s.name, 'USAGE')
      OR pg_catalog.has_schema_privilege(r.role, s.name, 'CREATE')),
  0::bigint,
  'anon, authenticated and service_role have no USAGE/CREATE on core, crm, capture or tracking'
);

SELECT is(
  (SELECT count(*) FROM pg_catalog.pg_class c
   JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) AS a
   WHERE n.nspname IN ('core', 'crm', 'capture', 'tracking')
     AND (a.grantee = 0 OR a.grantee IN (
       SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')))),
  0::bigint,
  'no relation of the private schemas is granted to PUBLIC, anon, authenticated or service_role'
);

SELECT is(
  (SELECT count(*) FROM pg_catalog.pg_proc p
   JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) AS a
   WHERE n.nspname IN ('core', 'crm', 'capture', 'tracking')
     AND (a.grantee = 0 OR a.grantee IN (
       SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')))),
  0::bigint,
  'no function of the private schemas is executable by PUBLIC, anon, authenticated or service_role'
);

-- lp_api: exact allow-list of table privileges (no DELETE, TRUNCATE, REFERENCES or TRIGGER) --------------

SELECT set_eq(
  $$ SELECT n.nspname || '.' || c.relname, a.privilege_type
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) AS a
     WHERE n.nspname IN ('core', 'crm', 'capture', 'tracking') AND a.grantee = 'lp_api'::regrole::oid $$,
  $$ VALUES
       ('core.workspaces', 'SELECT'),
       ('core.forms', 'SELECT'),
       ('core.audit_log', 'SELECT'), ('core.audit_log', 'INSERT'),
       ('crm.leads', 'SELECT'), ('crm.leads', 'INSERT'), ('crm.leads', 'UPDATE'),
       ('crm.lead_activities', 'SELECT'), ('crm.lead_activities', 'INSERT'),
       ('capture.submissions', 'SELECT'), ('capture.submissions', 'INSERT'),
       ('capture.consents', 'SELECT'), ('capture.consents', 'INSERT'),
       ('tracking.outbox_events', 'SELECT'), ('tracking.outbox_events', 'INSERT'), ('tracking.outbox_events', 'UPDATE'),
       ('tracking.deliveries', 'SELECT'), ('tracking.deliveries', 'INSERT'), ('tracking.deliveries', 'UPDATE') $$,
  'lp_api table privileges match database.md section 4 exactly'
);

SELECT set_eq(
  $$ SELECT n.nspname || '.' || c.relname || '.' || at.attname, a.privilege_type
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_catalog.pg_attribute at ON at.attrelid = c.oid
     CROSS JOIN LATERAL pg_catalog.aclexplode(at.attacl) AS a
     WHERE n.nspname IN ('core', 'crm', 'capture', 'tracking') AND a.grantee = 'lp_api'::regrole::oid $$,
  $$ VALUES
       ('capture.submissions.client_ip', 'UPDATE'),
       ('capture.submissions.user_agent', 'UPDATE'),
       ('capture.submissions.pii_purged_at', 'UPDATE') $$,
  'lp_api column privileges: only the PII purge columns of capture.submissions are updatable'
);

SELECT ok(
  NOT pg_catalog.has_schema_privilege('lp_api', 'auth', 'USAGE')
    AND NOT pg_catalog.has_table_privilege('lp_api', 'auth.users', 'SELECT')
    AND NOT pg_catalog.has_schema_privilege('lp_api', 'public', 'CREATE'),
  'lp_api cannot reach auth.* and cannot create objects in public'
);

SELECT ok(
  NOT pg_catalog.has_database_privilege('lp_api', pg_catalog.current_database(), 'CREATE'),
  'lp_api cannot create schemas'
);

-- Indexes -----------------------------------------------------------------------------------------------

SELECT is(
  (SELECT count(*) FROM pg_catalog.pg_index i
   JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
   JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   LEFT JOIN pg_catalog.pg_description d
     ON d.objoid = c.oid AND d.classoid = 'pg_catalog.pg_class'::regclass AND d.objsubid = 0
   WHERE n.nspname IN ('core', 'crm', 'capture', 'tracking') AND NOT i.indisprimary AND d.description IS NULL),
  0::bigint,
  'every non-primary-key index carries a comment explaining its use case'
);

SELECT has_index('crm', 'leads', 'leads_workspace_email_active_key', ARRAY['workspace_id', 'email'],
  'dedupe index exists on (workspace_id, email)');

SELECT is(
  (SELECT pg_catalog.pg_get_expr(i.indpred, i.indrelid) FROM pg_catalog.pg_index i
   WHERE i.indexrelid = 'crm.leads_workspace_email_active_key'::regclass),
  '(anonymized_at IS NULL)',
  'the dedupe index is partial: anonymized leads leave it'
);

SELECT col_is_pk('core', 'audit_log', 'id', 'audit_log.id is the primary key');

-- Tenant-safe references: every foreign key except the one to core.workspaces is composite on workspace_id first.
SELECT cmp_ok(
  (SELECT count(*) FROM pg_catalog.pg_constraint c
   JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
   JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
   WHERE c.contype = 'f' AND n.nspname IN ('core', 'crm', 'capture', 'tracking')
     AND c.confrelid <> 'core.workspaces'::regclass),
  '>=', 6::bigint,
  'the composite (workspace_id, id) foreign keys exist'
);

SELECT is(
  (SELECT count(*) FROM pg_catalog.pg_constraint c
   JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
   JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
   WHERE c.contype = 'f' AND n.nspname IN ('core', 'crm', 'capture', 'tracking')
     AND c.confrelid <> 'core.workspaces'::regclass
     AND NOT (
       cardinality(c.conkey) = 2
       AND (SELECT a.attname FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = c.conkey[1]) = 'workspace_id'
       AND (SELECT a.attname FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.confrelid AND a.attnum = c.confkey[1]) = 'workspace_id'
       AND (SELECT a.attname FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.confrelid AND a.attnum = c.confkey[2]) = 'id'
     )),
  0::bigint,
  'no foreign key between workspace-scoped tables is single-column: all reference (workspace_id, id)'
);

SELECT * FROM finish();
ROLLBACK;
