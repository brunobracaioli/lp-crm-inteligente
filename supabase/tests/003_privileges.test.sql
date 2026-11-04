-- AC-DB-01 (Data API roles are denied), AC-DB-04 (lp_api has no DELETE and no DDL) and
-- AC-DB-05 (append-only tables), checked at both layers: privileges (lp_api) and triggers (owner).
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(62);

-- Fixtures (as the migration owner) -----------------------------------------------------------------------

INSERT INTO core.workspaces (id, slug, name) VALUES
  ('0193bbbb-0000-7000-8000-00000000000a', 'test-priv-a', 'Privileges A');
INSERT INTO core.forms (id, workspace_id, form_key, name, allowed_origins, privacy_policy_version) VALUES
  ('0193bbbb-0000-7000-8000-0000000000f1', '0193bbbb-0000-7000-8000-00000000000a', 'frm_test_priv', 'Priv form', ARRAY['https://a.example.com'], '2026-11-03');
INSERT INTO crm.leads (id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name, area_of_expertise, first_submitted_at, last_submitted_at) VALUES
  ('0193bbbb-0000-7000-8000-0000000000a1', '0193bbbb-0000-7000-8000-00000000000a', 'Ana', 'Souza', 'ana@example.com', '+5511912345678', 'Empresa A', 'technology', now(), now());
INSERT INTO capture.submissions (id, workspace_id, form_id, lead_id, idempotency_key, request_hash, event_id, fields, message, consent_state, client_ip, user_agent, ip_hmac, antibot) VALUES
  ('0193bbbb-0000-7000-8000-0000000000a2', '0193bbbb-0000-7000-8000-00000000000a', '0193bbbb-0000-7000-8000-0000000000f1', '0193bbbb-0000-7000-8000-0000000000a1',
   '0193bbbb-0000-7000-8000-0000000000a7', repeat('a', 64), '0193bbbb-0000-7000-8000-0000000000a8', '{}', 'original message',
   '{"analytics_storage":"denied","ad_storage":"denied","ad_user_data":"denied","ad_personalization":"denied"}',
   '203.0.113.7', 'test-agent', repeat('b', 64), '{"provider":"turnstile"}');
INSERT INTO capture.consents (id, workspace_id, lead_id, submission_id, purpose, granted, policy_version) VALUES
  ('0193bbbb-0000-7000-8000-0000000000a3', '0193bbbb-0000-7000-8000-00000000000a', '0193bbbb-0000-7000-8000-0000000000a1', '0193bbbb-0000-7000-8000-0000000000a2', 'privacy_policy', true, '2026-11-03');
INSERT INTO crm.lead_activities (id, workspace_id, lead_id, type, actor_type) VALUES
  ('0193bbbb-0000-7000-8000-0000000000a4', '0193bbbb-0000-7000-8000-00000000000a', '0193bbbb-0000-7000-8000-0000000000a1', 'submission_received', 'system');
INSERT INTO core.audit_log (workspace_id, actor_type, action, resource_type, result, correlation_id) VALUES
  ('0193bbbb-0000-7000-8000-00000000000a', 'system', 'lead.created', 'lead', 'success', '0193bbbb-0000-7000-8000-0000000000a9');

-- pgTAP lives in `extensions`; the test role needs to reach it. Both grants are rolled back with the test.
GRANT lp_api TO postgres WITH SET TRUE;
GRANT USAGE ON SCHEMA extensions TO lp_api;

-- AC-DB-01: anon, authenticated (and service_role) cannot SELECT from any table --------------------------------

SET LOCAL ROLE anon;
SELECT throws_ok($$ SELECT 1 FROM core.workspaces $$, '42501', NULL, 'AC-DB-01: anon denied on core.workspaces');
SELECT throws_ok($$ SELECT 1 FROM core.forms $$, '42501', NULL, 'AC-DB-01: anon denied on core.forms');
SELECT throws_ok($$ SELECT 1 FROM core.audit_log $$, '42501', NULL, 'AC-DB-01: anon denied on core.audit_log');
SELECT throws_ok($$ SELECT 1 FROM crm.leads $$, '42501', NULL, 'AC-DB-01: anon denied on crm.leads');
SELECT throws_ok($$ SELECT 1 FROM crm.lead_activities $$, '42501', NULL, 'AC-DB-01: anon denied on crm.lead_activities');
SELECT throws_ok($$ SELECT 1 FROM capture.submissions $$, '42501', NULL, 'AC-DB-01: anon denied on capture.submissions');
SELECT throws_ok($$ SELECT 1 FROM capture.consents $$, '42501', NULL, 'AC-DB-01: anon denied on capture.consents');
SELECT throws_ok($$ SELECT 1 FROM tracking.outbox_events $$, '42501', NULL, 'AC-DB-01: anon denied on tracking.outbox_events');
SELECT throws_ok($$ SELECT 1 FROM tracking.deliveries $$, '42501', NULL, 'AC-DB-01: anon denied on tracking.deliveries');
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT 1 FROM core.workspaces $$, '42501', NULL, 'AC-DB-01: authenticated denied on core.workspaces');
SELECT throws_ok($$ SELECT 1 FROM core.forms $$, '42501', NULL, 'AC-DB-01: authenticated denied on core.forms');
SELECT throws_ok($$ SELECT 1 FROM core.audit_log $$, '42501', NULL, 'AC-DB-01: authenticated denied on core.audit_log');
SELECT throws_ok($$ SELECT 1 FROM crm.leads $$, '42501', NULL, 'AC-DB-01: authenticated denied on crm.leads');
SELECT throws_ok($$ SELECT 1 FROM crm.lead_activities $$, '42501', NULL, 'AC-DB-01: authenticated denied on crm.lead_activities');
SELECT throws_ok($$ SELECT 1 FROM capture.submissions $$, '42501', NULL, 'AC-DB-01: authenticated denied on capture.submissions');
SELECT throws_ok($$ SELECT 1 FROM capture.consents $$, '42501', NULL, 'AC-DB-01: authenticated denied on capture.consents');
SELECT throws_ok($$ SELECT 1 FROM tracking.outbox_events $$, '42501', NULL, 'AC-DB-01: authenticated denied on tracking.outbox_events');
SELECT throws_ok($$ SELECT 1 FROM tracking.deliveries $$, '42501', NULL, 'AC-DB-01: authenticated denied on tracking.deliveries');
RESET ROLE;

-- service_role bypasses RLS but has no schema USAGE: the Data API secret key cannot reach these schemas either.
SET LOCAL ROLE service_role;
SELECT throws_ok($$ SELECT 1 FROM core.workspaces $$, '42501', NULL, 'service_role denied on core.workspaces');
SELECT throws_ok($$ SELECT 1 FROM core.forms $$, '42501', NULL, 'service_role denied on core.forms');
SELECT throws_ok($$ SELECT 1 FROM core.audit_log $$, '42501', NULL, 'service_role denied on core.audit_log');
SELECT throws_ok($$ SELECT 1 FROM crm.leads $$, '42501', NULL, 'service_role denied on crm.leads');
SELECT throws_ok($$ SELECT 1 FROM crm.lead_activities $$, '42501', NULL, 'service_role denied on crm.lead_activities');
SELECT throws_ok($$ SELECT 1 FROM capture.submissions $$, '42501', NULL, 'service_role denied on capture.submissions');
SELECT throws_ok($$ SELECT 1 FROM capture.consents $$, '42501', NULL, 'service_role denied on capture.consents');
SELECT throws_ok($$ SELECT 1 FROM tracking.outbox_events $$, '42501', NULL, 'service_role denied on tracking.outbox_events');
SELECT throws_ok($$ SELECT 1 FROM tracking.deliveries $$, '42501', NULL, 'service_role denied on tracking.deliveries');
RESET ROLE;

-- AC-DB-04: lp_api has no DELETE, no TRUNCATE and no DDL ----------------------------------------------------------

SET LOCAL ROLE lp_api;
SET LOCAL app.workspace_id = '0193bbbb-0000-7000-8000-00000000000a';

SELECT throws_ok($$ DELETE FROM core.workspaces $$, '42501', NULL, 'AC-DB-04: lp_api cannot DELETE from core.workspaces');
SELECT throws_ok($$ DELETE FROM core.forms $$, '42501', NULL, 'AC-DB-04: lp_api cannot DELETE from core.forms');
SELECT throws_ok($$ DELETE FROM core.audit_log $$, '42501', NULL, 'AC-DB-04: lp_api cannot DELETE from core.audit_log');
SELECT throws_ok($$ DELETE FROM crm.leads $$, '42501', NULL, 'AC-DB-04: lp_api cannot DELETE from crm.leads');
SELECT throws_ok($$ DELETE FROM crm.lead_activities $$, '42501', NULL, 'AC-DB-04: lp_api cannot DELETE from crm.lead_activities');
SELECT throws_ok($$ DELETE FROM capture.submissions $$, '42501', NULL, 'AC-DB-04: lp_api cannot DELETE from capture.submissions');
SELECT throws_ok($$ DELETE FROM capture.consents $$, '42501', NULL, 'AC-DB-04: lp_api cannot DELETE from capture.consents');
SELECT throws_ok($$ DELETE FROM tracking.outbox_events $$, '42501', NULL, 'AC-DB-04: lp_api cannot DELETE from tracking.outbox_events');
SELECT throws_ok($$ DELETE FROM tracking.deliveries $$, '42501', NULL, 'AC-DB-04: lp_api cannot DELETE from tracking.deliveries');

SELECT throws_ok($$ TRUNCATE crm.leads $$, '42501', NULL, 'AC-DB-04: lp_api cannot TRUNCATE crm.leads');
SELECT throws_ok($$ TRUNCATE core.audit_log $$, '42501', NULL, 'AC-DB-04: lp_api cannot TRUNCATE core.audit_log');

SELECT throws_ok($$ CREATE TABLE core.evil (id int) $$, '42501', NULL, 'AC-DB-04: lp_api cannot CREATE TABLE in core');
SELECT throws_ok($$ CREATE TABLE public.evil (id int) $$, '42501', NULL, 'AC-DB-04: lp_api cannot CREATE TABLE in public');
SELECT throws_ok($$ CREATE SCHEMA evil $$, '42501', NULL, 'AC-DB-04: lp_api cannot CREATE SCHEMA');
SELECT throws_ok(
  $$ CREATE FUNCTION core.evil() RETURNS int LANGUAGE sql AS 'SELECT 1' $$,
  '42501', NULL, 'AC-DB-04: lp_api cannot CREATE FUNCTION in core'
);
SELECT throws_ok($$ DROP TABLE crm.leads $$, '42501', NULL, 'AC-DB-04: lp_api cannot DROP TABLE');
SELECT throws_ok($$ ALTER TABLE crm.leads DISABLE ROW LEVEL SECURITY $$, '42501', NULL, 'AC-DB-04: lp_api cannot disable RLS');
SELECT throws_ok($$ ALTER TABLE crm.leads ADD COLUMN evil int $$, '42501', NULL, 'AC-DB-04: lp_api cannot ALTER TABLE');

SELECT throws_ok(
  $$ SET LOCAL session_replication_role = 'replica' $$,
  '42501', NULL, 'lp_api cannot switch off triggers and foreign keys via session_replication_role'
);

SELECT throws_ok(
  $$ UPDATE capture.submissions SET message = 'tampered' $$,
  '42501', NULL, 'lp_api cannot update submission content (column-level grant)'
);
SELECT lives_ok(
  $$ UPDATE capture.submissions SET client_ip = NULL, user_agent = NULL, pii_purged_at = now() $$,
  'lp_api can purge raw IP and user agent (column-level grant)'
);

SELECT throws_ok($$ SELECT 1 FROM auth.users $$, '42501', NULL, 'lp_api cannot read auth.users');
SELECT throws_ok($$ SELECT 1 FROM pg_catalog.pg_authid $$, '42501', NULL, 'lp_api cannot read pg_authid (password hashes)');

-- AC-DB-05, privilege layer: lp_api cannot UPDATE the append-only tables (DELETE is covered above) --------------

SELECT throws_ok($$ UPDATE capture.consents SET granted = false $$, '42501', NULL, 'AC-DB-05: lp_api cannot UPDATE capture.consents');
SELECT throws_ok($$ UPDATE crm.lead_activities SET type = 'anonymized' $$, '42501', NULL, 'AC-DB-05: lp_api cannot UPDATE crm.lead_activities');
SELECT throws_ok($$ UPDATE core.audit_log SET result = 'error' $$, '42501', NULL, 'AC-DB-05: lp_api cannot UPDATE core.audit_log');

RESET ROLE;

-- AC-DB-05, trigger layer: even the table owner cannot rewrite history ---------------------------------------------

SELECT throws_ok(
  $$ UPDATE capture.consents SET granted = false $$,
  '23001', 'append-only table: UPDATE on capture.consents is not allowed',
  'AC-DB-05: UPDATE on capture.consents is blocked by trigger'
);
SELECT throws_ok(
  $$ DELETE FROM capture.consents $$,
  '23001', 'append-only table: DELETE on capture.consents is not allowed',
  'AC-DB-05: DELETE on capture.consents is blocked by trigger'
);
SELECT throws_ok(
  $$ TRUNCATE capture.consents $$,
  '23001', 'append-only table: TRUNCATE on capture.consents is not allowed',
  'AC-DB-05: TRUNCATE on capture.consents is blocked by trigger'
);
SELECT throws_ok(
  $$ UPDATE crm.lead_activities SET type = 'anonymized' $$,
  '23001', 'append-only table: UPDATE on crm.lead_activities is not allowed',
  'AC-DB-05: UPDATE on crm.lead_activities is blocked by trigger'
);
SELECT throws_ok(
  $$ DELETE FROM crm.lead_activities $$,
  '23001', 'append-only table: DELETE on crm.lead_activities is not allowed',
  'AC-DB-05: DELETE on crm.lead_activities is blocked by trigger'
);
SELECT throws_ok(
  $$ TRUNCATE crm.lead_activities $$,
  '23001', 'append-only table: TRUNCATE on crm.lead_activities is not allowed',
  'AC-DB-05: TRUNCATE on crm.lead_activities is blocked by trigger'
);
SELECT throws_ok(
  $$ UPDATE core.audit_log SET result = 'error' $$,
  '23001', 'append-only table: UPDATE on core.audit_log is not allowed',
  'AC-DB-05: UPDATE on core.audit_log is blocked by trigger'
);
SELECT throws_ok(
  $$ DELETE FROM core.audit_log $$,
  '23001', 'append-only table: DELETE on core.audit_log is not allowed',
  'AC-DB-05: DELETE on core.audit_log is blocked by trigger'
);
SELECT throws_ok(
  $$ TRUNCATE core.audit_log $$,
  '23001', 'append-only table: TRUNCATE on core.audit_log is not allowed',
  'AC-DB-05: TRUNCATE on core.audit_log is blocked by trigger'
);

SELECT * FROM finish();
ROLLBACK;
