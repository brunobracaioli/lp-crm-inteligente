-- Tenant-safe composite foreign keys: a child row of workspace B can never reference a parent of workspace A.
-- Foreign-key checks bypass RLS, so they are the only barrier here; the tests run as the migration owner
-- (BYPASSRLS) to keep RLS out of the picture and expect foreign_key_violation (23503) from the exact constraint.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(11);

-- Fixtures: workspaces A and B, each with a form and a lead; a submission and an outbox event in A ----------------

INSERT INTO core.workspaces (id, slug, name) VALUES
  ('0193eeee-0000-7000-8000-00000000000a', 'test-fk-a', 'FK A'),
  ('0193eeee-0000-7000-8000-00000000000b', 'test-fk-b', 'FK B');
INSERT INTO core.forms (id, workspace_id, form_key, name, allowed_origins, privacy_policy_version) VALUES
  ('0193eeee-0000-7000-8000-0000000000f1', '0193eeee-0000-7000-8000-00000000000a', 'frm_test_fk_a', 'FK form A', ARRAY['https://a.example.com'], '2026-11-03'),
  ('0193eeee-0000-7000-8000-0000000000f2', '0193eeee-0000-7000-8000-00000000000b', 'frm_test_fk_b', 'FK form B', ARRAY['https://b.example.com'], '2026-11-03');
INSERT INTO crm.leads (id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name, area_of_expertise, first_submitted_at, last_submitted_at) VALUES
  ('0193eeee-0000-7000-8000-0000000000a1', '0193eeee-0000-7000-8000-00000000000a', 'Ana', 'Souza', 'ana@example.com', '+5511912345678', 'Empresa A', 'technology', now(), now()),
  ('0193eeee-0000-7000-8000-0000000000b1', '0193eeee-0000-7000-8000-00000000000b', 'Bia', 'Lima', 'bia@example.com', '+5511987654321', 'Empresa B', 'finance', now(), now());
INSERT INTO capture.submissions (id, workspace_id, form_id, lead_id, idempotency_key, request_hash, event_id, fields, consent_state, ip_hmac, antibot) VALUES
  ('0193eeee-0000-7000-8000-0000000000a2', '0193eeee-0000-7000-8000-00000000000a', '0193eeee-0000-7000-8000-0000000000f1', '0193eeee-0000-7000-8000-0000000000a1',
   '0193eeee-0000-7000-8000-0000000000a7', repeat('a', 64), '0193eeee-0000-7000-8000-0000000000a8', '{}',
   '{"analytics_storage":"denied","ad_storage":"denied","ad_user_data":"denied","ad_personalization":"denied"}', repeat('b', 64), '{}'),
  ('0193eeee-0000-7000-8000-0000000000b2', '0193eeee-0000-7000-8000-00000000000b', '0193eeee-0000-7000-8000-0000000000f2', '0193eeee-0000-7000-8000-0000000000b1',
   '0193eeee-0000-7000-8000-0000000000b7', repeat('a', 64), '0193eeee-0000-7000-8000-0000000000b8', '{}',
   '{"analytics_storage":"denied","ad_storage":"denied","ad_user_data":"denied","ad_personalization":"denied"}', repeat('b', 64), '{}');
INSERT INTO tracking.outbox_events (id, workspace_id, aggregate_type, aggregate_id, event_type, payload) VALUES
  ('0193eeee-0000-7000-8000-0000000000a5', '0193eeee-0000-7000-8000-00000000000a', 'lead', '0193eeee-0000-7000-8000-0000000000a1', 'lead.captured', '{}');

-- A child of workspace B pointing at a parent of workspace A is rejected --------------------------------------------

SELECT throws_ok(
  $$ INSERT INTO capture.submissions (id, workspace_id, form_id, lead_id, idempotency_key, request_hash, event_id, fields, consent_state, ip_hmac, antibot)
     VALUES ('0193eeee-0000-7000-8000-0000000000c1', '0193eeee-0000-7000-8000-00000000000b', '0193eeee-0000-7000-8000-0000000000f2', '0193eeee-0000-7000-8000-0000000000a1',
       '0193eeee-0000-7000-8000-0000000000c7', repeat('a', 64), '0193eeee-0000-7000-8000-0000000000c8', '{}',
       '{"analytics_storage":"denied","ad_storage":"denied","ad_user_data":"denied","ad_personalization":"denied"}', repeat('b', 64), '{}') $$,
  '23503', 'insert or update on table "submissions" violates foreign key constraint "submissions_lead_fkey"',
  'submission of workspace B -> lead of workspace A is rejected'
);
SELECT throws_ok(
  $$ INSERT INTO capture.submissions (id, workspace_id, form_id, lead_id, idempotency_key, request_hash, event_id, fields, consent_state, ip_hmac, antibot)
     VALUES ('0193eeee-0000-7000-8000-0000000000c2', '0193eeee-0000-7000-8000-00000000000b', '0193eeee-0000-7000-8000-0000000000f1', '0193eeee-0000-7000-8000-0000000000b1',
       '0193eeee-0000-7000-8000-0000000000c9', repeat('a', 64), '0193eeee-0000-7000-8000-0000000000ca', '{}',
       '{"analytics_storage":"denied","ad_storage":"denied","ad_user_data":"denied","ad_personalization":"denied"}', repeat('b', 64), '{}') $$,
  '23503', 'insert or update on table "submissions" violates foreign key constraint "submissions_form_fkey"',
  'submission of workspace B -> form of workspace A is rejected'
);
SELECT throws_ok(
  $$ INSERT INTO capture.consents (id, workspace_id, lead_id, submission_id, purpose, granted, policy_version)
     VALUES ('0193eeee-0000-7000-8000-0000000000c3', '0193eeee-0000-7000-8000-00000000000b', '0193eeee-0000-7000-8000-0000000000b1', '0193eeee-0000-7000-8000-0000000000a2', 'privacy_policy', true, '2026-11-03') $$,
  '23503', 'insert or update on table "consents" violates foreign key constraint "consents_submission_fkey"',
  'consent of workspace B -> submission of workspace A is rejected'
);
SELECT throws_ok(
  $$ INSERT INTO capture.consents (id, workspace_id, lead_id, submission_id, purpose, granted, policy_version)
     VALUES ('0193eeee-0000-7000-8000-0000000000c4', '0193eeee-0000-7000-8000-00000000000b', '0193eeee-0000-7000-8000-0000000000a1', '0193eeee-0000-7000-8000-0000000000b2', 'privacy_policy', true, '2026-11-03') $$,
  '23503', 'insert or update on table "consents" violates foreign key constraint "consents_lead_fkey"',
  'consent of workspace B -> lead of workspace A is rejected'
);
SELECT throws_ok(
  $$ INSERT INTO crm.lead_activities (id, workspace_id, lead_id, type, actor_type)
     VALUES ('0193eeee-0000-7000-8000-0000000000c5', '0193eeee-0000-7000-8000-00000000000b', '0193eeee-0000-7000-8000-0000000000a1', 'note_added', 'user') $$,
  '23503', 'insert or update on table "lead_activities" violates foreign key constraint "lead_activities_lead_fkey"',
  'activity of workspace B -> lead of workspace A is rejected'
);
SELECT throws_ok(
  $$ INSERT INTO tracking.deliveries (id, outbox_event_id, workspace_id, destination)
     VALUES ('0193eeee-0000-7000-8000-0000000000c6', '0193eeee-0000-7000-8000-0000000000a5', '0193eeee-0000-7000-8000-00000000000b', 'meta_capi') $$,
  '23503', 'insert or update on table "deliveries" violates foreign key constraint "deliveries_outbox_event_fkey"',
  'delivery of workspace B -> outbox event of workspace A is rejected'
);

-- A parent that has children cannot be moved to another workspace -----------------------------------------------------

SELECT throws_ok(
  $$ UPDATE crm.leads SET workspace_id = '0193eeee-0000-7000-8000-00000000000b' WHERE id = '0193eeee-0000-7000-8000-0000000000a1' $$,
  '23503', 'update or delete on table "leads" violates foreign key constraint "submissions_lead_fkey" on table "submissions"',
  'a lead referenced by a submission cannot be moved to another workspace'
);

-- Controls: the same links inside one workspace are accepted --------------------------------------------------------

SELECT lives_ok(
  $$ INSERT INTO capture.consents (id, workspace_id, lead_id, submission_id, purpose, granted, policy_version)
     VALUES ('0193eeee-0000-7000-8000-0000000000d1', '0193eeee-0000-7000-8000-00000000000a', '0193eeee-0000-7000-8000-0000000000a1', '0193eeee-0000-7000-8000-0000000000a2', 'privacy_policy', true, '2026-11-03') $$,
  'control: consent -> lead and submission of the same workspace is accepted'
);
SELECT lives_ok(
  $$ INSERT INTO crm.lead_activities (id, workspace_id, lead_id, type, actor_type)
     VALUES ('0193eeee-0000-7000-8000-0000000000d2', '0193eeee-0000-7000-8000-00000000000a', '0193eeee-0000-7000-8000-0000000000a1', 'note_added', 'user') $$,
  'control: activity -> lead of the same workspace is accepted'
);
SELECT lives_ok(
  $$ INSERT INTO tracking.deliveries (id, outbox_event_id, workspace_id, destination)
     VALUES ('0193eeee-0000-7000-8000-0000000000d3', '0193eeee-0000-7000-8000-0000000000a5', '0193eeee-0000-7000-8000-00000000000a', 'meta_capi') $$,
  'control: delivery -> outbox event of the same workspace is accepted'
);

-- A child cannot be re-homed into another workspace either.
SELECT throws_ok(
  $$ UPDATE tracking.deliveries SET workspace_id = '0193eeee-0000-7000-8000-00000000000b' WHERE id = '0193eeee-0000-7000-8000-0000000000d3' $$,
  '23503', 'insert or update on table "deliveries" violates foreign key constraint "deliveries_outbox_event_fkey"',
  'a delivery cannot be re-homed into another workspace'
);

SELECT * FROM finish();
ROLLBACK;
