-- The real POST /v1/leads transaction (lead-capture section 2, step 11) and the outbox sweeper, replayed as lp_api.
-- Proves the grants and RLS policies are sufficient for the runtime (wave 4). Production runs lp_api with an empty
-- search_path; here the path only contains `extensions` (pgTAP), so any unqualified table name would still fail.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(17);

-- Fixtures (as the migration owner): a workspace and its public form.
INSERT INTO core.workspaces (id, slug, name) VALUES
  ('0193dddd-0000-7000-8000-00000000000a', 'test-load-a', 'Workload A');
INSERT INTO core.forms (id, workspace_id, form_key, name, allowed_origins, privacy_policy_version) VALUES
  ('0193dddd-0000-7000-8000-0000000000f1', '0193dddd-0000-7000-8000-00000000000a', 'frm_test_load', 'Workload form', ARRAY['https://a.example.com'], '2026-11-03');

GRANT lp_api TO postgres WITH SET TRUE;
GRANT USAGE ON SCHEMA extensions TO lp_api;

SET LOCAL ROLE lp_api;
SET LOCAL search_path = extensions;

-- Step 5: public routing by form_key, before any workspace is known.
SELECT is(
  (SELECT workspace_id FROM core.forms WHERE form_key = 'frm_test_load' AND status = 'active'),
  '0193dddd-0000-7000-8000-00000000000a'::uuid,
  'form lookup by form_key works without a workspace and yields the workspace id'
);

-- Start of the unit of work: set_config(..., true) as the API does.
SELECT pg_catalog.set_config('app.workspace_id', '0193dddd-0000-7000-8000-00000000000a', true);

SELECT is(
  (SELECT slug FROM core.workspaces),
  'test-load-a',
  'the workspace row (settings/ICP) is readable once the workspace is set'
);

-- Step 11: lead upsert (crm), submission, consents, activity, outbox, audit.
SELECT lives_ok(
  $$ INSERT INTO crm.leads (
       id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name, area_of_expertise,
       score, score_band, score_breakdown, marketing_opt_in, first_touch, last_touch, first_submitted_at, last_submitted_at)
     VALUES (
       '0193dddd-0000-7000-8000-0000000000a1', '0193dddd-0000-7000-8000-00000000000a', 'Ana', 'Souza',
       'ana@example.com', '+5511912345678', 'Empresa A', 'technology', 40, 'B', '[]', true, '{}', '{}', now(), now())
     ON CONFLICT (workspace_id, email) WHERE anonymized_at IS NULL DO NOTHING $$,
  'lead insert with ON CONFLICT (workspace_id, email) WHERE anonymized_at IS NULL'
);

SELECT lives_ok(
  $$ INSERT INTO crm.leads (
       id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name, area_of_expertise,
       first_submitted_at, last_submitted_at)
     VALUES (
       '0193dddd-0000-7000-8000-0000000000a2', '0193dddd-0000-7000-8000-00000000000a', 'Ana', 'Souza',
       'ana@example.com', '+5511912345678', 'Empresa A', 'technology', now(), now())
     ON CONFLICT (workspace_id, email) WHERE anonymized_at IS NULL
     DO UPDATE SET submissions_count = crm.leads.submissions_count + 1, last_submitted_at = EXCLUDED.last_submitted_at,
                   version = crm.leads.version + 1 $$,
  'lead upsert (ON CONFLICT DO UPDATE) for a returning visitor'
);

SELECT is(
  (SELECT submissions_count FROM crm.leads WHERE email = 'ana@example.com'),
  2,
  'the returning visitor incremented submissions_count on the single lead'
);

SELECT lives_ok(
  $$ SELECT id, version FROM crm.leads WHERE workspace_id = '0193dddd-0000-7000-8000-00000000000a' AND email = 'ana@example.com' AND anonymized_at IS NULL FOR UPDATE $$,
  'SELECT ... FOR UPDATE on the active lead (findActiveByEmailForUpdate)'
);

SELECT lives_ok(
  $$ INSERT INTO capture.submissions (
       id, workspace_id, form_id, lead_id, idempotency_key, request_hash, event_id, fields, message,
       utm_source, fbclid, consent_state, client_ip, user_agent, ip_hmac, antibot)
     VALUES (
       '0193dddd-0000-7000-8000-0000000000a3', '0193dddd-0000-7000-8000-00000000000a', '0193dddd-0000-7000-8000-0000000000f1',
       '0193dddd-0000-7000-8000-0000000000a1', '0193dddd-0000-7000-8000-0000000000a7', repeat('a', 64),
       '0193dddd-0000-7000-8000-0000000000a8', '{"company":"Empresa A"}', 'Quero integrar o CRM.', 'meta', 'IwAR123',
       '{"analytics_storage":"granted","ad_storage":"granted","ad_user_data":"granted","ad_personalization":"denied"}',
       '203.0.113.7', 'test-agent', repeat('b', 64), '{"provider":"turnstile","challenge_age_s":4}')
     ON CONFLICT (workspace_id, idempotency_key) DO NOTHING $$,
  'submission insert with ON CONFLICT (workspace_id, idempotency_key) DO NOTHING'
);

SELECT lives_ok(
  $$ INSERT INTO capture.consents (id, workspace_id, lead_id, submission_id, purpose, granted, policy_version) VALUES
       ('0193dddd-0000-7000-8000-0000000000a4', '0193dddd-0000-7000-8000-00000000000a', '0193dddd-0000-7000-8000-0000000000a1', '0193dddd-0000-7000-8000-0000000000a3', 'privacy_policy', true, '2026-11-03'),
       ('0193dddd-0000-7000-8000-0000000000a5', '0193dddd-0000-7000-8000-00000000000a', '0193dddd-0000-7000-8000-0000000000a1', '0193dddd-0000-7000-8000-0000000000a3', 'marketing_communications', true, '2026-11-03'),
       ('0193dddd-0000-7000-8000-0000000000a6', '0193dddd-0000-7000-8000-00000000000a', '0193dddd-0000-7000-8000-0000000000a1', '0193dddd-0000-7000-8000-0000000000a3', 'ad_tracking', true, '2026-11-03') $$,
  'three consent rows appended'
);

SELECT lives_ok(
  $$ INSERT INTO crm.lead_activities (id, workspace_id, lead_id, type, actor_type, data)
     VALUES ('0193dddd-0000-7000-8000-0000000000a9', '0193dddd-0000-7000-8000-00000000000a', '0193dddd-0000-7000-8000-0000000000a1',
             'submission_received', 'system', '{"submission_id":"0193dddd-0000-7000-8000-0000000000a3"}') $$,
  'activity appended'
);

SELECT lives_ok(
  $$ INSERT INTO tracking.outbox_events (id, workspace_id, aggregate_type, aggregate_id, event_type, payload)
     VALUES ('0193dddd-0000-7000-8000-0000000000b1', '0193dddd-0000-7000-8000-00000000000a', 'lead', '0193dddd-0000-7000-8000-0000000000a1',
             'lead.captured', '{"lead_id":"0193dddd-0000-7000-8000-0000000000a1","submission_id":"0193dddd-0000-7000-8000-0000000000a3"}') $$,
  'outbox event inserted in the same transaction'
);

SELECT lives_ok(
  $$ INSERT INTO core.audit_log (workspace_id, actor_type, action, resource_type, resource_id, result, correlation_id, metadata)
     VALUES ('0193dddd-0000-7000-8000-00000000000a', 'system', 'lead.created', 'lead', '0193dddd-0000-7000-8000-0000000000a1', 'success',
             '0193dddd-0000-7000-8000-0000000000c1', '{"source":"public_form"}') $$,
  'audit entry inserted (identity key needs no sequence privilege)'
);

-- Outbox dispatcher / sweeper (tracking section 5.1).
SELECT lives_ok(
  $$ SELECT id FROM tracking.outbox_events
     WHERE status IN ('pending', 'processing') AND next_attempt_at <= pg_catalog.now()
     ORDER BY next_attempt_at LIMIT 10 FOR UPDATE SKIP LOCKED $$,
  'sweeper picks pending events with FOR UPDATE SKIP LOCKED'
);

SELECT lives_ok(
  $$ INSERT INTO tracking.deliveries (id, outbox_event_id, workspace_id, destination)
     VALUES ('0193dddd-0000-7000-8000-0000000000d1', '0193dddd-0000-7000-8000-0000000000b1', '0193dddd-0000-7000-8000-00000000000a', 'meta_capi')
     ON CONFLICT (outbox_event_id, destination) DO NOTHING $$,
  'delivery created idempotently per destination'
);

SELECT lives_ok(
  $$ UPDATE tracking.deliveries SET status = 'sent', attempts = attempts + 1, last_http_status = 200, external_ref = 'fbtrace_test'
     WHERE id = '0193dddd-0000-7000-8000-0000000000d1' $$,
  'delivery marked sent'
);

SELECT lives_ok(
  $$ UPDATE tracking.outbox_events SET status = 'done', processed_at = pg_catalog.now() WHERE id = '0193dddd-0000-7000-8000-0000000000b1' $$,
  'outbox event marked done'
);

-- Optimistic lock as the CRM will use it (expected_version).
SELECT lives_ok(
  $$ UPDATE crm.leads SET stage = 'contacted', version = version + 1
     WHERE id = '0193dddd-0000-7000-8000-0000000000a1' AND version = 2 $$,
  'stage change guarded by expected_version'
);
SELECT is(
  (SELECT version FROM crm.leads WHERE id = '0193dddd-0000-7000-8000-0000000000a1'),
  3,
  'the version moved from 2 to 3 exactly once'
);

SELECT * FROM finish();
ROLLBACK;
