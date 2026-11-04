-- Wave 6b crm.anonymize_lead (database section 6, AC-DB-08, AC-CRM-09, threat model C35 / G4): the contract
-- (true / false cases, workspace scoping, privileges), everything erased (lead, attribution, submissions,
-- note bodies, payloads) and everything kept (IDs, stage, score, dates, consents), plus the append-only guard of
-- the timeline. Mirrored by apps/api/test/integration/anonymize-lead.test.ts (which also covers concurrency).
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(33);

-- Fixtures (as the migration owner) -----------------------------------------------------------------------

INSERT INTO core.workspaces (id, slug, name) VALUES
  ('0193ffff-0000-7000-8000-00000000000a', 'test-anon-a', 'Anonymize A'),
  ('0193ffff-0000-7000-8000-00000000000b', 'test-anon-b', 'Anonymize B');
INSERT INTO core.forms (id, workspace_id, form_key, name, allowed_origins, privacy_policy_version) VALUES
  ('0193ffff-0000-7000-8000-0000000000f1', '0193ffff-0000-7000-8000-00000000000a', 'frm_test_anon', 'Anonymize form', ARRAY['https://a.example.com'], '2026-11-03');

-- The lead under test: PII in every place the erasure must reach.
INSERT INTO crm.leads (
  id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name, company_website, job_title,
  area_of_expertise, area_of_expertise_other, stage, lost_reason, score, score_band, marketing_opt_in,
  first_touch, last_touch, first_submitted_at, last_submitted_at)
VALUES (
  '0193ffff-0000-7000-8000-0000000000a1', '0193ffff-0000-7000-8000-00000000000a', 'Zuleica', 'Quaresma',
  'zuleica@acme.example', '+5511987654321', 'Acme Quimica Ltda', 'https://acme-quimica.example', 'Diretora Comercial',
  'other', 'Gestao de frotas refrigeradas', 'lost', 'no_budget', 61, 'B', true,
  '{"utm_source":"meta","fbclid":"IwAR-original","fbp":"fb.1.original","ga_client_id":"GA1.original","landing_page_url":"https://www.dominio.com.br/lp?email=zuleica@acme.example","referrer_url":"https://referrer.example/path?q=secret"}',
  '{"utm_source":"meta","gclid":"gclid-original","landing_page_url":"https://www.dominio.com.br/lp?utm_source=meta"}',
  '2026-01-10T12:00:00Z', '2026-02-10T12:00:00Z');
-- Another lead of the same workspace (invalid-actor test), and a lead of workspace B (cross-tenant test).
INSERT INTO crm.leads (id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name, area_of_expertise, first_submitted_at, last_submitted_at) VALUES
  ('0193ffff-0000-7000-8000-0000000000a3', '0193ffff-0000-7000-8000-00000000000a', 'Caio', 'Dias', 'caio@example.com', '+5511911112222', 'Empresa C', 'technology', now(), now()),
  ('0193ffff-0000-7000-8000-0000000000b1', '0193ffff-0000-7000-8000-00000000000b', 'Beto', 'Rocha', 'beto@example.com', '+5511933334444', 'Empresa B', 'technology', now(), now());

INSERT INTO capture.submissions (
  id, workspace_id, form_id, lead_id, idempotency_key, request_hash, event_id, fields, message, utm_source, gclid, fbclid,
  fbp, fbc, ga_client_id, landing_page_url, referrer_url, consent_state, client_ip, user_agent, ip_hmac, antibot)
VALUES (
  '0193ffff-0000-7000-8000-0000000000a2', '0193ffff-0000-7000-8000-00000000000a', '0193ffff-0000-7000-8000-0000000000f1',
  '0193ffff-0000-7000-8000-0000000000a1', gen_random_uuid(), repeat('a', 64), gen_random_uuid(), '{"name":"Zuleica Quaresma"}',
  'Please call me about the Quaresma contract', 'meta', 'gclid-value', 'fbclid-value', 'fbp-value', 'fbc-value',
  'ga-client-value', 'https://www.dominio.com.br/lp?utm_source=meta&email=zuleica@acme.example',
  'https://referrer.example/path?q=secret',
  '{"analytics_storage":"granted","ad_storage":"granted","ad_user_data":"granted","ad_personalization":"granted"}',
  '203.0.113.7', 'Mozilla/5.0 (original)', repeat('b', 64), '{"provider":"turnstile","challenge_age_s":3,"ephemeral_id":"eph-123"}');
INSERT INTO capture.consents (id, workspace_id, lead_id, submission_id, purpose, granted, policy_version) VALUES
  (gen_random_uuid(), '0193ffff-0000-7000-8000-00000000000a', '0193ffff-0000-7000-8000-0000000000a1', '0193ffff-0000-7000-8000-0000000000a2', 'privacy_policy', true, '2026-11-03');
INSERT INTO crm.lead_activities (id, workspace_id, lead_id, type, actor_type, data, created_at) VALUES
  (gen_random_uuid(), '0193ffff-0000-7000-8000-00000000000a', '0193ffff-0000-7000-8000-0000000000a1', 'submission_received', 'system',
   '{"submission_id":"0193ffff-0000-7000-8000-0000000000a2","score":61,"score_band":"B","comment":"Zuleica private comment"}', now() - interval '2 days'),
  (gen_random_uuid(), '0193ffff-0000-7000-8000-00000000000a', '0193ffff-0000-7000-8000-0000000000a1', 'note_added', 'user',
   '{"body":"Zuleica said her husband owns the company"}', now() - interval '1 day'),
  (gen_random_uuid(), '0193ffff-0000-7000-8000-00000000000a', '0193ffff-0000-7000-8000-0000000000a1', 'stage_changed', 'user',
   '{"from":"new","to":"lost","lost_reason":"no_budget"}', now() - interval '12 hours');

GRANT lp_api TO postgres WITH SET TRUE;
GRANT USAGE ON SCHEMA extensions TO lp_api;

-- Contract, as lp_api (the role the API uses) -----------------------------------------------------------------

SET LOCAL ROLE lp_api;

-- No app.workspace_id yet: nothing is visible, so nothing is anonymized.
SELECT is(
  crm.anonymize_lead('0193ffff-0000-7000-8000-0000000000a1', 'user', '0193ffff-0000-7000-8000-0000000000c1', '0193ffff-0000-7000-8000-0000000000d1'),
  false,
  'false when no workspace is in scope'
);

-- Workspace B in scope: a lead of workspace A is invisible.
SELECT pg_catalog.set_config('app.workspace_id', '0193ffff-0000-7000-8000-00000000000b', true);
SELECT is(
  crm.anonymize_lead('0193ffff-0000-7000-8000-0000000000a1', 'user', '0193ffff-0000-7000-8000-0000000000c1', '0193ffff-0000-7000-8000-0000000000d1'),
  false,
  'false for a lead of another workspace (cross-tenant)'
);

SELECT pg_catalog.set_config('app.workspace_id', '0193ffff-0000-7000-8000-00000000000a', true);
SELECT is(
  crm.anonymize_lead('0193ffff-0000-7000-8000-0000000000ff', 'user', '0193ffff-0000-7000-8000-0000000000c1', '0193ffff-0000-7000-8000-0000000000d1'),
  false,
  'false for an unknown lead'
);
SELECT throws_ok(
  $$ SELECT crm.anonymize_lead('0193ffff-0000-7000-8000-0000000000a3', 'robot', NULL, '0193ffff-0000-7000-8000-0000000000d1') $$,
  '23514', NULL, 'an actor type outside the activity CHECK is rejected'
);
SELECT throws_ok(
  $$ SELECT crm.anonymize_lead('0193ffff-0000-7000-8000-0000000000a3', 'user', NULL, NULL) $$,
  '22023', NULL, 'a missing correlation id is rejected'
);
RESET ROLE;

SELECT ok(
  (SELECT anonymized_at IS NULL AND version = 1 FROM crm.leads WHERE id = '0193ffff-0000-7000-8000-0000000000a1')
    AND (SELECT anonymized_at IS NULL AND version = 1 FROM crm.leads WHERE id = '0193ffff-0000-7000-8000-0000000000a3'),
  'the false and error cases changed nothing'
);

SET LOCAL ROLE lp_api;
SELECT pg_catalog.set_config('app.workspace_id', '0193ffff-0000-7000-8000-00000000000a', true);
SELECT is(
  crm.anonymize_lead('0193ffff-0000-7000-8000-0000000000a1', 'user', '0193ffff-0000-7000-8000-0000000000c1', '0193ffff-0000-7000-8000-0000000000d1'),
  true,
  'true when it anonymizes a lead of the current workspace'
);
SELECT is(
  crm.anonymize_lead('0193ffff-0000-7000-8000-0000000000a1', 'user', '0193ffff-0000-7000-8000-0000000000c1', '0193ffff-0000-7000-8000-0000000000d1'),
  false,
  'false when the lead is already anonymized (idempotent)'
);
RESET ROLE;

-- What is erased ------------------------------------------------------------------------------------------------

SELECT results_eq(
  $$ SELECT first_name, last_name, email, whatsapp_e164, company_name, company_website, job_title, area_of_expertise_other, marketing_opt_in
     FROM crm.leads WHERE id = '0193ffff-0000-7000-8000-0000000000a1' $$,
  $$ VALUES ('Anonymized', 'Lead', 'anon+0193ffff-0000-7000-8000-0000000000a1@anonymized.invalid', '+10000000000',
             'Anonymized', NULL::text, NULL::text, 'anonymized', false) $$,
  'identifying columns are replaced by irreversible placeholders (every CHECK holds, or the UPDATE would have failed)'
);
SELECT is(
  (SELECT first_touch FROM crm.leads WHERE id = '0193ffff-0000-7000-8000-0000000000a1'),
  '{"utm_source":"meta","landing_page_url":"https://www.dominio.com.br/lp","referrer_url":"https://referrer.example/path"}'::jsonb,
  'first_touch keeps UTMs and URLs without query string; click IDs, fbp and ga_client_id are gone'
);
SELECT is(
  (SELECT last_touch FROM crm.leads WHERE id = '0193ffff-0000-7000-8000-0000000000a1'),
  '{"utm_source":"meta","landing_page_url":"https://www.dominio.com.br/lp"}'::jsonb,
  'last_touch is scrubbed the same way'
);
SELECT results_eq(
  $$ SELECT fields, message, utm_source, gclid, fbclid, fbp, fbc, ga_client_id, landing_page_url, referrer_url,
            client_ip, user_agent, ip_hmac, request_hash, antibot
     FROM capture.submissions WHERE id = '0193ffff-0000-7000-8000-0000000000a2' $$,
  $$ VALUES ('{}'::jsonb, NULL::text, 'meta', NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
             'https://www.dominio.com.br/lp', 'https://referrer.example/path', NULL::inet, NULL::text,
             repeat('0', 64), repeat('0', 64), '{"provider":"turnstile","challenge_age_s":3}'::jsonb) $$,
  'submission: form snapshot, message, click IDs, cookies, IP, user agent, hashes and ephemeral id are cleared'
);
SELECT ok(
  (SELECT pii_purged_at IS NOT NULL FROM capture.submissions WHERE id = '0193ffff-0000-7000-8000-0000000000a2'),
  'submission: pii_purged_at is set (the purge consistency CHECK holds)'
);
SELECT is(
  (SELECT data FROM crm.lead_activities WHERE lead_id = '0193ffff-0000-7000-8000-0000000000a1' AND type = 'note_added'),
  '{"body": "[anonymized]"}'::jsonb,
  'the note body is scrubbed (G4)'
);
SELECT is(
  (SELECT data FROM crm.lead_activities WHERE lead_id = '0193ffff-0000-7000-8000-0000000000a1' AND type = 'submission_received'),
  '{"submission_id":"0193ffff-0000-7000-8000-0000000000a2","score":61,"score_band":"B"}'::jsonb,
  'payloads keep only allow-listed ID / code / number keys'
);
SELECT is(
  (SELECT data FROM crm.lead_activities WHERE lead_id = '0193ffff-0000-7000-8000-0000000000a1' AND type = 'stage_changed'),
  '{"from":"new","to":"lost","lost_reason":"no_budget"}'::jsonb,
  'stage_changed codes are kept'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM (
      SELECT to_jsonb(t)::text AS blob FROM crm.leads t WHERE workspace_id = '0193ffff-0000-7000-8000-00000000000a'
      UNION ALL SELECT to_jsonb(t)::text FROM capture.submissions t WHERE workspace_id = '0193ffff-0000-7000-8000-00000000000a'
      UNION ALL SELECT to_jsonb(t)::text FROM capture.consents t WHERE workspace_id = '0193ffff-0000-7000-8000-00000000000a'
      UNION ALL SELECT to_jsonb(t)::text FROM crm.lead_activities t WHERE workspace_id = '0193ffff-0000-7000-8000-00000000000a'
      UNION ALL SELECT to_jsonb(t)::text FROM tracking.outbox_events t WHERE workspace_id = '0193ffff-0000-7000-8000-00000000000a'
      UNION ALL SELECT to_jsonb(t)::text FROM core.audit_log t WHERE workspace_id = '0193ffff-0000-7000-8000-00000000000a'
    ) AS b
    WHERE b.blob ILIKE ANY (ARRAY[
      '%zuleica%', '%quaresma%', '%5511987654321%', '%acme%', '%diretora%', '%frotas%', '%203.0.113.7%',
      '%mozilla%', '%IwAR-original%', '%fb.1.original%', '%GA1.original%', '%gclid-%', '%q=secret%'])
  ),
  'no table of the workspace still contains the original name, e-mail, phone, company, text, IP or identifiers'
);

-- What is kept ---------------------------------------------------------------------------------------------------

SELECT results_eq(
  $$ SELECT stage, lost_reason, score, score_band, area_of_expertise, submissions_count, first_submitted_at, last_submitted_at, version
     FROM crm.leads WHERE id = '0193ffff-0000-7000-8000-0000000000a1' $$,
  $$ VALUES ('lost', 'no_budget', 61::smallint, 'B', 'other', 1, '2026-01-10T12:00:00Z'::timestamptz, '2026-02-10T12:00:00Z'::timestamptz, 2) $$,
  'stage, score, band, area, counters and dates are kept; the optimistic-lock version is bumped'
);
SELECT ok(
  (SELECT anonymized_at = now() FROM crm.leads WHERE id = '0193ffff-0000-7000-8000-0000000000a1'),
  'anonymized_at is set'
);
SELECT is(
  (SELECT count(*) FROM capture.consents WHERE lead_id = '0193ffff-0000-7000-8000-0000000000a1'),
  1::bigint,
  'consents are kept as proof'
);
SELECT results_eq(
  $$ SELECT actor_type, actor_id, data FROM crm.lead_activities
     WHERE lead_id = '0193ffff-0000-7000-8000-0000000000a1' AND type = 'anonymized' $$,
  $$ VALUES ('user', '0193ffff-0000-7000-8000-0000000000c1'::uuid, '{}'::jsonb) $$,
  'exactly one anonymized activity with the given actor'
);
SELECT is(
  (SELECT count(*) FROM core.audit_log WHERE workspace_id = '0193ffff-0000-7000-8000-00000000000a'),
  0::bigint,
  'the function writes no audit row: the API audits (including denials)'
);
SELECT results_eq(
  $$ SELECT first_name, anonymized_at IS NULL, version FROM crm.leads WHERE id = '0193ffff-0000-7000-8000-0000000000b1' $$,
  $$ VALUES ('Beto', true, 1) $$,
  'the lead of the other workspace is untouched'
);

-- AC-DB-08 / AC-CRM-09: the e-mail is free again ------------------------------------------------------------------

SELECT lives_ok(
  $$ INSERT INTO crm.leads (id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name, area_of_expertise, first_submitted_at, last_submitted_at)
     VALUES ('0193ffff-0000-7000-8000-0000000000a4', '0193ffff-0000-7000-8000-00000000000a', 'Zuleica', 'Quaresma',
             'zuleica@acme.example', '+5511987654321', 'Acme Quimica Ltda', 'technology', now(), now()) $$,
  'AC-CRM-09: the same e-mail can be inserted again as a new lead after anonymization'
);

-- The timeline stays append-only outside the function --------------------------------------------------------------

SELECT throws_ok(
  $$ UPDATE crm.lead_activities SET data = '{}' WHERE lead_id = '0193ffff-0000-7000-8000-0000000000a1' $$,
  '23001', 'append-only table: UPDATE on crm.lead_activities is not allowed',
  'the scrub exception does not outlive the function: UPDATE is blocked again'
);
SELECT throws_ok(
  $$ DELETE FROM crm.lead_activities WHERE lead_id = '0193ffff-0000-7000-8000-0000000000a1' $$,
  '23001', 'append-only table: DELETE on crm.lead_activities is not allowed',
  'DELETE is never allowed'
);
SET LOCAL app.lead_anonymization = 'on';
SELECT throws_ok(
  $$ UPDATE crm.lead_activities SET type = 'note_added' WHERE lead_id = '0193ffff-0000-7000-8000-0000000000a1' $$,
  '23001', 'append-only table: UPDATE on crm.lead_activities is not allowed',
  'a forged flag still cannot change anything but data (type)'
);
SELECT throws_ok(
  $$ UPDATE crm.lead_activities SET created_at = now() WHERE lead_id = '0193ffff-0000-7000-8000-0000000000a1' $$,
  '23001', 'append-only table: UPDATE on crm.lead_activities is not allowed',
  'a forged flag still cannot change anything but data (timestamp)'
);
SELECT throws_ok(
  $$ DELETE FROM crm.lead_activities WHERE lead_id = '0193ffff-0000-7000-8000-0000000000a1' $$,
  '23001', 'append-only table: DELETE on crm.lead_activities is not allowed',
  'a forged flag still cannot DELETE'
);
SET LOCAL app.lead_anonymization = 'off';

-- Privileges --------------------------------------------------------------------------------------------------------

SET LOCAL ROLE lp_api;
SELECT throws_ok(
  $$ UPDATE crm.lead_activities SET data = '{}' $$,
  '42501', NULL, 'lp_api still cannot UPDATE the timeline directly'
);
RESET ROLE;
SET LOCAL ROLE anon;
SELECT throws_ok(
  $$ SELECT crm.anonymize_lead('0193ffff-0000-7000-8000-0000000000a3', 'user', NULL, gen_random_uuid()) $$,
  '42501', NULL, 'anon cannot execute crm.anonymize_lead'
);
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT crm.anonymize_lead('0193ffff-0000-7000-8000-0000000000a3', 'user', NULL, gen_random_uuid()) $$,
  '42501', NULL, 'authenticated cannot execute crm.anonymize_lead'
);
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT throws_ok(
  $$ SELECT crm.anonymize_lead('0193ffff-0000-7000-8000-0000000000a3', 'user', NULL, gen_random_uuid()) $$,
  '42501', NULL, 'service_role cannot execute crm.anonymize_lead'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
