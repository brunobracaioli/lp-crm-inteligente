-- Wave 6b retention jobs (database section 6): 30-day PII purge, 90-day outbox purge, 12-month audit purge,
-- 24-month lead inactivity, their privileges and their pg_cron schedules.
-- A pgTAP transaction has one fixed now(), so every boundary below is exact: a row exactly at the cutoff is
-- NOT purged (the jobs use strict "older than"). Mirrored by apps/api/test/integration/retention.test.ts.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(43);

-- Fixtures (as the migration owner) -----------------------------------------------------------------------

INSERT INTO core.workspaces (id, slug, name) VALUES
  ('0193eeee-0000-7000-8000-00000000000a', 'test-ret-a', 'Retention A'),
  ('0193eeee-0000-7000-8000-00000000000b', 'test-ret-b', 'Retention B');
INSERT INTO core.forms (id, workspace_id, form_key, name, allowed_origins, privacy_policy_version) VALUES
  ('0193eeee-0000-7000-8000-0000000000f1', '0193eeee-0000-7000-8000-00000000000a', 'frm_test_ret', 'Retention form', ARRAY['https://a.example.com'], '2026-11-03');

-- Lead of the purge tests; the inactivity leads are inserted further down.
INSERT INTO crm.leads (id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name, area_of_expertise, first_submitted_at, last_submitted_at) VALUES
  ('0193eeee-0000-7000-8000-0000000000a1', '0193eeee-0000-7000-8000-00000000000a', 'Ana', 'Souza', 'ana@example.com', '+5511912345678', 'Empresa A', 'technology', now(), now());

-- 1. capture.purge_submission_pii: 30 days ---------------------------------------------------------------------

INSERT INTO capture.submissions (id, workspace_id, form_id, lead_id, idempotency_key, request_hash, event_id, fields, consent_state, client_ip, user_agent, ip_hmac, antibot, created_at)
SELECT v.id::uuid, '0193eeee-0000-7000-8000-00000000000a', '0193eeee-0000-7000-8000-0000000000f1', '0193eeee-0000-7000-8000-0000000000a1',
       gen_random_uuid(), repeat('a', 64), gen_random_uuid(), '{}',
       '{"analytics_storage":"denied","ad_storage":"denied","ad_user_data":"denied","ad_personalization":"denied"}',
       '203.0.113.7', 'test-agent', repeat('b', 64), '{"provider":"turnstile"}', now() - v.age
FROM (VALUES
  ('0193eeee-0000-7000-8000-000000000101', interval '31 days'),
  ('0193eeee-0000-7000-8000-000000000102', interval '30 days'),
  ('0193eeee-0000-7000-8000-000000000103', interval '30 days 1 second'),
  ('0193eeee-0000-7000-8000-000000000104', interval '1 day')
) AS v (id, age);

SELECT is(capture.purge_submission_pii(), 2, 'purge returns the number of submissions it handled (31 days and 30 days + 1 s)');
SELECT ok(
  (SELECT client_ip IS NULL AND user_agent IS NULL FROM capture.submissions WHERE id = '0193eeee-0000-7000-8000-000000000101'),
  'older than 30 days: client_ip and user_agent are NULL'
);
SELECT ok(
  (SELECT client_ip IS NULL AND user_agent IS NULL FROM capture.submissions WHERE id = '0193eeee-0000-7000-8000-000000000103'),
  '30 days + 1 second: purged'
);
SELECT is(
  (SELECT pii_purged_at FROM capture.submissions WHERE id = '0193eeee-0000-7000-8000-000000000101'),
  now(),
  'pii_purged_at is set when the purge runs'
);
SELECT is(
  (SELECT ip_hmac FROM capture.submissions WHERE id = '0193eeee-0000-7000-8000-000000000101'),
  repeat('b', 64),
  'the anti-fraud ip_hmac survives the purge'
);
SELECT ok(
  (SELECT client_ip IS NOT NULL AND user_agent IS NOT NULL AND pii_purged_at IS NULL FROM capture.submissions WHERE id = '0193eeee-0000-7000-8000-000000000102'),
  'exactly 30 days old: not purged yet (strict cutoff)'
);
SELECT ok(
  (SELECT client_ip IS NOT NULL AND user_agent IS NOT NULL AND pii_purged_at IS NULL FROM capture.submissions WHERE id = '0193eeee-0000-7000-8000-000000000104'),
  'newer than 30 days: untouched'
);
SELECT is(capture.purge_submission_pii(), 0, 'idempotent: a second run handles nothing');

-- Batching: 1 row per batch, at most 2 batches per run, the backlog continues on the next run.
INSERT INTO capture.submissions (id, workspace_id, form_id, lead_id, idempotency_key, request_hash, event_id, fields, consent_state, client_ip, user_agent, ip_hmac, antibot, created_at)
SELECT v.id::uuid, '0193eeee-0000-7000-8000-00000000000a', '0193eeee-0000-7000-8000-0000000000f1', '0193eeee-0000-7000-8000-0000000000a1',
       gen_random_uuid(), repeat('a', 64), gen_random_uuid(), '{}',
       '{"analytics_storage":"denied","ad_storage":"denied","ad_user_data":"denied","ad_personalization":"denied"}',
       '203.0.113.8', 'test-agent', repeat('b', 64), '{"provider":"turnstile"}', now() - interval '60 days'
FROM (VALUES
  ('0193eeee-0000-7000-8000-000000000105'),
  ('0193eeee-0000-7000-8000-000000000106'),
  ('0193eeee-0000-7000-8000-000000000107')
) AS v (id);

SELECT is(capture.purge_submission_pii(1, 2), 2, 'batch size 1 x 2 batches handles at most 2 rows per run');
SELECT is(capture.purge_submission_pii(1, 5), 1, 'the next run continues with the remaining backlog');
SELECT throws_ok($$ SELECT capture.purge_submission_pii(0, 1) $$, '22023', NULL, 'batch size 0 is rejected');
SELECT throws_ok($$ SELECT capture.purge_submission_pii(10, 0) $$, '22023', NULL, 'max batches 0 is rejected');

-- 2. tracking.purge_completed_outbox: 90 days ------------------------------------------------------------------

INSERT INTO tracking.outbox_events (id, workspace_id, aggregate_type, aggregate_id, event_type, payload, status, processed_at)
SELECT v.id::uuid, '0193eeee-0000-7000-8000-00000000000a', 'lead', '0193eeee-0000-7000-8000-0000000000a1', 'lead.captured', '{}',
       v.status, CASE WHEN v.age IS NULL THEN NULL ELSE now() - v.age END
FROM (VALUES
  ('0193eeee-0000-7000-8000-000000000201', 'done', interval '91 days'),
  ('0193eeee-0000-7000-8000-000000000202', 'done', interval '90 days'),
  ('0193eeee-0000-7000-8000-000000000203', 'done', interval '89 days'),
  ('0193eeee-0000-7000-8000-000000000204', 'pending', NULL::interval),
  ('0193eeee-0000-7000-8000-000000000205', 'processing', interval '200 days'),
  ('0193eeee-0000-7000-8000-000000000206', 'dead', interval '200 days'),
  ('0193eeee-0000-7000-8000-000000000207', 'done', interval '200 days')
) AS v (id, status, age);

INSERT INTO tracking.deliveries (id, outbox_event_id, workspace_id, destination, status)
VALUES
  (gen_random_uuid(), '0193eeee-0000-7000-8000-000000000201', '0193eeee-0000-7000-8000-00000000000a', 'meta_capi', 'sent'),
  (gen_random_uuid(), '0193eeee-0000-7000-8000-000000000201', '0193eeee-0000-7000-8000-00000000000a', 'ga4_mp', 'skipped_no_consent'),
  (gen_random_uuid(), '0193eeee-0000-7000-8000-000000000206', '0193eeee-0000-7000-8000-00000000000a', 'meta_capi', 'dead'),
  (gen_random_uuid(), '0193eeee-0000-7000-8000-000000000207', '0193eeee-0000-7000-8000-00000000000a', 'meta_capi', 'failed');

SELECT is(tracking.purge_completed_outbox(), 1, 'only the done event older than 90 days is deleted');
SELECT is(
  (SELECT count(*) FROM tracking.outbox_events WHERE id = '0193eeee-0000-7000-8000-000000000201'),
  0::bigint,
  'the 91-day done event is gone'
);
SELECT is(
  (SELECT count(*) FROM tracking.deliveries WHERE outbox_event_id = '0193eeee-0000-7000-8000-000000000201'),
  0::bigint,
  'its deliveries are gone with it'
);
SELECT is(
  (SELECT count(*) FROM tracking.outbox_events WHERE workspace_id = '0193eeee-0000-7000-8000-00000000000a'),
  6::bigint,
  'done at exactly 90 days, done at 89 days, pending, processing, dead and done-with-failed-delivery are kept'
);
SELECT is(
  (SELECT count(*) FROM tracking.deliveries WHERE workspace_id = '0193eeee-0000-7000-8000-00000000000a'),
  2::bigint,
  'deliveries of kept events (dead, failed) are untouched'
);
SELECT is(tracking.purge_completed_outbox(), 0, 'idempotent: a second run deletes nothing');

-- 3. core.purge_audit_log: 12 months ---------------------------------------------------------------------------

INSERT INTO core.audit_log (workspace_id, occurred_at, actor_type, action, resource_type, result, correlation_id)
VALUES
  ('0193eeee-0000-7000-8000-00000000000a', now() - interval '12 months 1 day', 'system', 'audit.old', 'lead', 'success', gen_random_uuid()),
  ('0193eeee-0000-7000-8000-00000000000a', now() - interval '12 months', 'system', 'audit.edge', 'lead', 'success', gen_random_uuid()),
  ('0193eeee-0000-7000-8000-00000000000a', now() - interval '11 months', 'system', 'audit.young', 'lead', 'success', gen_random_uuid());

SELECT throws_ok(
  $$ DELETE FROM core.audit_log WHERE action = 'audit.old' $$,
  '23001', 'append-only table: DELETE on core.audit_log is not allowed',
  'outside the purge function even an old audit entry cannot be deleted'
);
SET LOCAL app.retention_purge = 'on';
SELECT throws_ok(
  $$ DELETE FROM core.audit_log WHERE action = 'audit.young' $$,
  '23001', 'append-only table: DELETE on core.audit_log is not allowed',
  'a forged retention flag cannot delete an entry younger than 12 months'
);
SELECT throws_ok(
  $$ UPDATE core.audit_log SET result = 'error' WHERE action = 'audit.old' $$,
  '23001', 'append-only table: UPDATE on core.audit_log is not allowed',
  'a forged retention flag never allows UPDATE'
);
SET LOCAL app.retention_purge = 'off';

SELECT is(core.purge_audit_log(), 1, 'only the entry older than 12 months is deleted');
SELECT is(
  (SELECT count(*) FROM core.audit_log WHERE action IN ('audit.old')),
  0::bigint,
  'the 12 months + 1 day entry is gone'
);
SELECT is(
  (SELECT count(*) FROM core.audit_log WHERE action IN ('audit.edge', 'audit.young')),
  2::bigint,
  'exactly 12 months and 11 months old entries are kept'
);
SELECT throws_ok(
  $$ DELETE FROM core.audit_log WHERE action = 'audit.edge' $$,
  '23001', 'append-only table: DELETE on core.audit_log is not allowed',
  'the purge flag does not outlive the function: the table is append-only again'
);
SELECT is(core.purge_audit_log(), 0, 'idempotent: a second run deletes nothing');

-- 4. crm.anonymize_inactive_leads: 24 months (Q5) --------------------------------------------------------------

INSERT INTO crm.leads (id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name, area_of_expertise, stage, first_submitted_at, last_submitted_at)
SELECT v.id::uuid, v.workspace::uuid, 'Bia', 'Lima', v.email, '+5511912345678', 'Empresa B', 'technology', v.stage, now() - v.age, now() - v.age
FROM (VALUES
  ('0193eeee-0000-7000-8000-000000000301', '0193eeee-0000-7000-8000-00000000000a', 'stale-a@example.com', 'new', interval '25 months'),
  ('0193eeee-0000-7000-8000-000000000302', '0193eeee-0000-7000-8000-00000000000b', 'stale-b@example.com', 'contacted', interval '26 months'),
  ('0193eeee-0000-7000-8000-000000000303', '0193eeee-0000-7000-8000-00000000000a', 'won@example.com', 'won', interval '30 months'),
  ('0193eeee-0000-7000-8000-000000000304', '0193eeee-0000-7000-8000-00000000000a', 'fresh@example.com', 'new', interval '23 months'),
  ('0193eeee-0000-7000-8000-000000000305', '0193eeee-0000-7000-8000-00000000000a', 'touched@example.com', 'new', interval '30 months'),
  ('0193eeee-0000-7000-8000-000000000306', '0193eeee-0000-7000-8000-00000000000a', 'edge@example.com', 'new', interval '24 months')
) AS v (id, workspace, email, stage, age);

INSERT INTO crm.lead_activities (id, workspace_id, lead_id, type, actor_type, data, created_at) VALUES
  (gen_random_uuid(), '0193eeee-0000-7000-8000-00000000000a', '0193eeee-0000-7000-8000-000000000305', 'note_added', 'user', '{"body": "called back"}', now() - interval '10 days');

SELECT is(crm.anonymize_inactive_leads(), 2, 'two inactive non-won leads are anonymized, across two workspaces without any scope');
SELECT is(
  (SELECT count(*) FROM crm.leads WHERE id IN ('0193eeee-0000-7000-8000-000000000301', '0193eeee-0000-7000-8000-000000000302') AND anonymized_at IS NOT NULL),
  2::bigint,
  '25 and 26 months without activity: anonymized'
);
SELECT is(
  (SELECT count(*) FROM crm.leads WHERE id IN (
     '0193eeee-0000-7000-8000-000000000303', '0193eeee-0000-7000-8000-000000000304',
     '0193eeee-0000-7000-8000-000000000305', '0193eeee-0000-7000-8000-000000000306') AND anonymized_at IS NOT NULL),
  0::bigint,
  'won, 23 months, recent timeline activity and exactly 24 months: untouched'
);
SELECT is(
  (SELECT count(*) FROM crm.lead_activities WHERE type = 'anonymized' AND actor_type = 'system' AND actor_id IS NULL
     AND lead_id IN ('0193eeee-0000-7000-8000-000000000301', '0193eeee-0000-7000-8000-000000000302')),
  2::bigint,
  'each anonymization is recorded as an activity of the system actor'
);
SELECT is(crm.anonymize_inactive_leads(), 0, 'idempotent: a second run anonymizes nothing');

-- 5. Privileges, definer posture and schedules -----------------------------------------------------------------

SELECT ok(
  (SELECT rolsuper OR rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = CURRENT_USER),
  'the owner of the definer functions bypasses RLS (forced RLS has policies for lp_api only)'
);
SELECT is(
  (SELECT count(*) FROM pg_catalog.pg_proc p
   WHERE p.oid IN (
     'capture.purge_submission_pii(integer,integer)'::regprocedure, 'tracking.purge_completed_outbox(integer,integer)'::regprocedure,
     'core.purge_audit_log(integer,integer)'::regprocedure, 'crm.anonymize_inactive_leads(integer,integer)'::regprocedure,
     'crm.anonymize_lead_unchecked(uuid,uuid,text,uuid,uuid)'::regprocedure, 'crm.anonymize_lead(uuid,text,uuid,uuid)'::regprocedure)
     AND p.prosecdef AND p.proconfig = ARRAY['search_path=""']),
  6::bigint,
  'all six retention / anonymization functions are SECURITY DEFINER with an empty search_path'
);
SELECT is(
  (SELECT count(*) FROM (VALUES ('anon'), ('authenticated'), ('service_role'), ('lp_api')) AS r (role)
   CROSS JOIN (VALUES
     ('capture.purge_submission_pii(integer,integer)'), ('tracking.purge_completed_outbox(integer,integer)'),
     ('core.purge_audit_log(integer,integer)'), ('crm.anonymize_inactive_leads(integer,integer)'),
     ('crm.anonymize_lead_unchecked(uuid,uuid,text,uuid,uuid)')) AS f (sig)
   WHERE pg_catalog.has_function_privilege(r.role, f.sig, 'EXECUTE')),
  0::bigint,
  'no runtime or Data API role can execute a purge function or the unchecked anonymizer (cron only)'
);
SELECT is(
  (SELECT count(*) FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r (role)
   WHERE pg_catalog.has_function_privilege(r.role, 'crm.anonymize_lead(uuid,text,uuid,uuid)', 'EXECUTE')),
  0::bigint,
  'crm.anonymize_lead is not executable by anon, authenticated or service_role'
);
SELECT ok(
  pg_catalog.has_function_privilege('lp_api', 'crm.anonymize_lead(uuid,text,uuid,uuid)', 'EXECUTE'),
  'crm.anonymize_lead is executable by lp_api'
);

GRANT lp_api TO postgres WITH SET TRUE;
GRANT USAGE ON SCHEMA extensions TO lp_api;
SET LOCAL ROLE lp_api;
SELECT throws_ok($$ SELECT capture.purge_submission_pii() $$, '42501', NULL, 'lp_api cannot run the PII purge');
SELECT throws_ok($$ SELECT tracking.purge_completed_outbox() $$, '42501', NULL, 'lp_api cannot run the outbox purge');
SELECT throws_ok($$ SELECT core.purge_audit_log() $$, '42501', NULL, 'lp_api cannot run the audit purge');
SELECT throws_ok($$ SELECT crm.anonymize_inactive_leads() $$, '42501', NULL, 'lp_api cannot run the inactivity job');
SELECT throws_ok(
  $$ SELECT crm.anonymize_lead_unchecked(gen_random_uuid(), gen_random_uuid(), 'system', NULL, gen_random_uuid()) $$,
  '42501', NULL, 'lp_api cannot call the unchecked anonymizer with a workspace of its choosing'
);
RESET ROLE;

SELECT ok(
  EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron'),
  'pg_cron is installed (the migration fails loudly otherwise)'
);
SELECT set_eq(
  $$ SELECT jobname, schedule, command FROM cron.job WHERE jobname LIKE 'lp-retention-%' $$,
  $$ VALUES
       ('lp-retention-purge-submission-pii', '15 3 * * *', 'SELECT capture.purge_submission_pii()'),
       ('lp-retention-purge-completed-outbox', '30 3 * * *', 'SELECT tracking.purge_completed_outbox()'),
       ('lp-retention-anonymize-inactive-leads', '0 4 * * *', 'SELECT crm.anonymize_inactive_leads()'),
       ('lp-retention-purge-audit-log', '45 3 1 * *', 'SELECT core.purge_audit_log()') $$,
  'the four retention jobs are scheduled: PII, outbox and inactivity daily, audit monthly (UTC)'
);

SELECT * FROM finish();
ROLLBACK;
