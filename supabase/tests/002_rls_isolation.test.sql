-- AC-DB-02 (no app.workspace_id -> no rows) and AC-DB-03 (cross-tenant read/update/insert denied).
-- Fixtures are inserted as the migration owner (BYPASSRLS); every assertion on data runs as lp_api.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(26);

-- Fixtures: workspaces A and B, each with the full chain of rows --------------------------------------------

INSERT INTO core.workspaces (id, slug, name) VALUES
  ('0193aaaa-0000-7000-8000-00000000000a', 'test-ws-a', 'Workspace A'),
  ('0193aaaa-0000-7000-8000-00000000000b', 'test-ws-b', 'Workspace B');

INSERT INTO core.forms (id, workspace_id, form_key, name, status, allowed_origins, privacy_policy_version) VALUES
  ('0193aaaa-0000-7000-8000-0000000000f1', '0193aaaa-0000-7000-8000-00000000000a', 'frm_test_a_active', 'A active', 'active', ARRAY['https://a.example.com'], '2026-11-03'),
  ('0193aaaa-0000-7000-8000-0000000000f2', '0193aaaa-0000-7000-8000-00000000000a', 'frm_test_a_paused', 'A paused', 'paused', ARRAY['https://a.example.com'], '2026-11-03'),
  ('0193aaaa-0000-7000-8000-0000000000f3', '0193aaaa-0000-7000-8000-00000000000b', 'frm_test_b_active', 'B active', 'active', ARRAY['https://b.example.com'], '2026-11-03'),
  ('0193aaaa-0000-7000-8000-0000000000f4', '0193aaaa-0000-7000-8000-00000000000b', 'frm_test_b_archived', 'B archived', 'archived', ARRAY['https://b.example.com'], '2026-11-03');

INSERT INTO crm.leads (id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name, area_of_expertise, first_submitted_at, last_submitted_at) VALUES
  ('0193aaaa-0000-7000-8000-0000000000a1', '0193aaaa-0000-7000-8000-00000000000a', 'Ana', 'Souza', 'ana@example.com', '+5511912345678', 'Empresa A', 'technology', now(), now()),
  ('0193aaaa-0000-7000-8000-0000000000b1', '0193aaaa-0000-7000-8000-00000000000b', 'Bia', 'Lima', 'bia@example.com', '+5511987654321', 'Empresa B', 'finance', now(), now());

INSERT INTO capture.submissions (id, workspace_id, form_id, lead_id, idempotency_key, request_hash, event_id, fields, consent_state, ip_hmac, antibot) VALUES
  ('0193aaaa-0000-7000-8000-0000000000a2', '0193aaaa-0000-7000-8000-00000000000a', '0193aaaa-0000-7000-8000-0000000000f1', '0193aaaa-0000-7000-8000-0000000000a1',
   '0193aaaa-0000-7000-8000-0000000000a7', repeat('a', 64), '0193aaaa-0000-7000-8000-0000000000a8', '{}',
   '{"analytics_storage":"denied","ad_storage":"denied","ad_user_data":"denied","ad_personalization":"denied"}', repeat('b', 64), '{"provider":"turnstile"}'),
  ('0193aaaa-0000-7000-8000-0000000000b2', '0193aaaa-0000-7000-8000-00000000000b', '0193aaaa-0000-7000-8000-0000000000f3', '0193aaaa-0000-7000-8000-0000000000b1',
   '0193aaaa-0000-7000-8000-0000000000b7', repeat('a', 64), '0193aaaa-0000-7000-8000-0000000000b8', '{}',
   '{"analytics_storage":"denied","ad_storage":"denied","ad_user_data":"denied","ad_personalization":"denied"}', repeat('b', 64), '{"provider":"turnstile"}');

INSERT INTO capture.consents (id, workspace_id, lead_id, submission_id, purpose, granted, policy_version) VALUES
  ('0193aaaa-0000-7000-8000-0000000000a3', '0193aaaa-0000-7000-8000-00000000000a', '0193aaaa-0000-7000-8000-0000000000a1', '0193aaaa-0000-7000-8000-0000000000a2', 'privacy_policy', true, '2026-11-03'),
  ('0193aaaa-0000-7000-8000-0000000000b3', '0193aaaa-0000-7000-8000-00000000000b', '0193aaaa-0000-7000-8000-0000000000b1', '0193aaaa-0000-7000-8000-0000000000b2', 'privacy_policy', true, '2026-11-03');

INSERT INTO crm.lead_activities (id, workspace_id, lead_id, type, actor_type) VALUES
  ('0193aaaa-0000-7000-8000-0000000000a4', '0193aaaa-0000-7000-8000-00000000000a', '0193aaaa-0000-7000-8000-0000000000a1', 'submission_received', 'system'),
  ('0193aaaa-0000-7000-8000-0000000000b4', '0193aaaa-0000-7000-8000-00000000000b', '0193aaaa-0000-7000-8000-0000000000b1', 'submission_received', 'system');

INSERT INTO tracking.outbox_events (id, workspace_id, aggregate_type, aggregate_id, event_type, payload) VALUES
  ('0193aaaa-0000-7000-8000-0000000000a5', '0193aaaa-0000-7000-8000-00000000000a', 'lead', '0193aaaa-0000-7000-8000-0000000000a1', 'lead.captured', '{}'),
  ('0193aaaa-0000-7000-8000-0000000000b5', '0193aaaa-0000-7000-8000-00000000000b', 'lead', '0193aaaa-0000-7000-8000-0000000000b1', 'lead.captured', '{}');

INSERT INTO tracking.deliveries (id, outbox_event_id, workspace_id, destination) VALUES
  ('0193aaaa-0000-7000-8000-0000000000a6', '0193aaaa-0000-7000-8000-0000000000a5', '0193aaaa-0000-7000-8000-00000000000a', 'meta_capi'),
  ('0193aaaa-0000-7000-8000-0000000000b6', '0193aaaa-0000-7000-8000-0000000000b5', '0193aaaa-0000-7000-8000-00000000000b', 'meta_capi');

INSERT INTO core.audit_log (workspace_id, actor_type, action, resource_type, result, correlation_id) VALUES
  ('0193aaaa-0000-7000-8000-00000000000a', 'system', 'lead.created', 'lead', 'success', '0193aaaa-0000-7000-8000-0000000000a9'),
  ('0193aaaa-0000-7000-8000-00000000000b', 'system', 'lead.created', 'lead', 'success', '0193aaaa-0000-7000-8000-0000000000b9');

-- pgTAP lives in `extensions`; the test role needs to reach it. Both grants are rolled back with the test.
GRANT lp_api TO postgres WITH SET TRUE;
GRANT USAGE ON SCHEMA extensions TO lp_api;
SET LOCAL ROLE lp_api;

-- AC-DB-02: without app.workspace_id the runtime role sees nothing ----------------------------------------

SELECT is((SELECT count(*) FROM crm.leads), 0::bigint, 'AC-DB-02: crm.leads is empty without app.workspace_id');
SELECT is((SELECT count(*) FROM capture.submissions), 0::bigint, 'AC-DB-02: capture.submissions is empty without app.workspace_id');
SELECT is((SELECT count(*) FROM capture.consents), 0::bigint, 'AC-DB-02: capture.consents is empty without app.workspace_id');
SELECT is((SELECT count(*) FROM crm.lead_activities), 0::bigint, 'AC-DB-02: crm.lead_activities is empty without app.workspace_id');
SELECT is((SELECT count(*) FROM tracking.outbox_events), 0::bigint, 'AC-DB-02: tracking.outbox_events is empty without app.workspace_id');
SELECT is((SELECT count(*) FROM tracking.deliveries), 0::bigint, 'AC-DB-02: tracking.deliveries is empty without app.workspace_id');
SELECT is((SELECT count(*) FROM core.audit_log), 0::bigint, 'AC-DB-02: core.audit_log is empty without app.workspace_id');
SELECT is((SELECT count(*) FROM core.workspaces), 0::bigint, 'AC-DB-02: core.workspaces is empty without app.workspace_id');

-- Forms are public routing data: active forms of any workspace are visible, paused/archived never.
SELECT set_eq(
  $$ SELECT form_key FROM core.forms WHERE form_key ~ '^frm_test_' $$,
  $$ VALUES ('frm_test_a_active'), ('frm_test_b_active') $$,
  'core.forms exposes only active forms, without workspace filter'
);

-- A reused pooled connection reads the transaction-local setting back as '' instead of NULL.
SET LOCAL app.workspace_id = '';
SELECT lives_ok($$ SELECT 1 FROM crm.leads $$, 'an empty app.workspace_id does not raise');
SELECT is((SELECT count(*) FROM crm.leads), 0::bigint, 'AC-DB-02: an empty app.workspace_id matches no row');

-- A malformed value fails closed.
SET LOCAL app.workspace_id = 'not-a-uuid';
SELECT throws_ok($$ SELECT 1 FROM crm.leads $$, '22P02', NULL, 'a malformed app.workspace_id raises instead of matching rows');

-- AC-DB-03: workspace A cannot read or change workspace B ----------------------------------------------------

SET LOCAL app.workspace_id = '0193aaaa-0000-7000-8000-00000000000a';

SELECT results_eq(
  $$ SELECT id FROM crm.leads $$,
  $$ VALUES ('0193aaaa-0000-7000-8000-0000000000a1'::uuid) $$,
  'AC-DB-03: workspace A sees only its own lead'
);
SELECT is(
  (SELECT count(*) FROM crm.leads WHERE id = '0193aaaa-0000-7000-8000-0000000000b1'),
  0::bigint,
  'AC-DB-03: a lead of workspace B is invisible even by primary key'
);
SELECT is(
  (SELECT (SELECT count(*) FROM capture.submissions WHERE workspace_id = '0193aaaa-0000-7000-8000-00000000000b')
        + (SELECT count(*) FROM capture.consents WHERE workspace_id = '0193aaaa-0000-7000-8000-00000000000b')
        + (SELECT count(*) FROM crm.lead_activities WHERE workspace_id = '0193aaaa-0000-7000-8000-00000000000b')
        + (SELECT count(*) FROM tracking.outbox_events WHERE workspace_id = '0193aaaa-0000-7000-8000-00000000000b')
        + (SELECT count(*) FROM tracking.deliveries WHERE workspace_id = '0193aaaa-0000-7000-8000-00000000000b')
        + (SELECT count(*) FROM core.audit_log WHERE workspace_id = '0193aaaa-0000-7000-8000-00000000000b')),
  0::bigint,
  'AC-DB-03: no dependent row of workspace B is visible to workspace A'
);
SELECT results_eq(
  $$ SELECT id FROM capture.submissions $$,
  $$ VALUES ('0193aaaa-0000-7000-8000-0000000000a2'::uuid) $$,
  'AC-DB-03: workspace A sees only its own submission'
);
SELECT results_eq(
  $$ SELECT slug FROM core.workspaces $$,
  $$ VALUES ('test-ws-a') $$,
  'AC-DB-03: core.workspaces exposes only the current workspace'
);

SELECT lives_ok(
  $$ UPDATE crm.leads SET first_name = 'Hacked' WHERE id = '0193aaaa-0000-7000-8000-0000000000b1' $$,
  'AC-DB-03: updating a lead of workspace B is a silent no-op'
);
SELECT lives_ok(
  $$ UPDATE crm.leads SET first_name = 'Anna' WHERE id = '0193aaaa-0000-7000-8000-0000000000a1' $$,
  'workspace A can update its own lead'
);
SELECT throws_ok(
  $$ INSERT INTO crm.leads (id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name, area_of_expertise, first_submitted_at, last_submitted_at)
     VALUES ('0193aaaa-0000-7000-8000-0000000000c1', '0193aaaa-0000-7000-8000-00000000000b', 'Eve', 'Mallory', 'eve@example.com', '+5511911112222', 'Evil Corp', 'legal', now(), now()) $$,
  '42501', NULL,
  'AC-DB-03: inserting a lead into workspace B while scoped to A is rejected'
);
SELECT throws_ok(
  $$ UPDATE crm.leads SET workspace_id = '0193aaaa-0000-7000-8000-00000000000b' WHERE id = '0193aaaa-0000-7000-8000-0000000000a1' $$,
  '42501', 'new row violates row-level security policy for table "leads"',
  'AC-DB-03: moving a lead to workspace B is rejected by WITH CHECK'
);
SELECT throws_ok(
  $$ INSERT INTO core.audit_log (workspace_id, actor_type, action, resource_type, result, correlation_id)
     VALUES ('0193aaaa-0000-7000-8000-00000000000b', 'system', 'lead.created', 'lead', 'success', '0193aaaa-0000-7000-8000-0000000000c9') $$,
  '42501', 'new row violates row-level security policy for table "audit_log"',
  'AC-DB-03: writing an audit entry for workspace B while scoped to A is rejected'
);

-- Back as the owner to prove the effects of the statements above.
RESET ROLE;
SELECT is(
  (SELECT first_name FROM crm.leads WHERE id = '0193aaaa-0000-7000-8000-0000000000b1'),
  'Bia',
  'AC-DB-03: the lead of workspace B is untouched'
);
SELECT is(
  (SELECT first_name FROM crm.leads WHERE id = '0193aaaa-0000-7000-8000-0000000000a1'),
  'Anna',
  'the update inside workspace A took effect'
);

-- Symmetry: scoped to B, only B is visible.
SET LOCAL ROLE lp_api;
SET LOCAL app.workspace_id = '0193aaaa-0000-7000-8000-00000000000b';
SELECT results_eq(
  $$ SELECT id FROM crm.leads $$,
  $$ VALUES ('0193aaaa-0000-7000-8000-0000000000b1'::uuid) $$,
  'AC-DB-03: workspace B sees only its own lead'
);
SELECT is(
  (SELECT count(*) FROM crm.leads WHERE id = '0193aaaa-0000-7000-8000-0000000000a1'),
  0::bigint,
  'AC-DB-03: a lead of workspace A is invisible to workspace B'
);

SELECT * FROM finish();
ROLLBACK;
