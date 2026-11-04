-- AC-DB-06 (lead CHECK constraints), AC-DB-07 (dedupe by ON CONFLICT), AC-DB-08 (anonymization frees the
-- e-mail) plus the CHECKs, unique keys and triggers of the other tables. Runs as the migration owner so
-- that only constraints and triggers are under test (privileges and RLS live in 002/003).
-- Each throws_ok pins both the SQLSTATE and the exact constraint, so a different constraint cannot pass by accident.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(67);

-- Fixtures ------------------------------------------------------------------------------------------------------

INSERT INTO core.workspaces (id, slug, name) VALUES
  ('0193cccc-0000-7000-8000-00000000000c', 'test-con-c', 'Constraints C'),
  ('0193cccc-0000-7000-8000-00000000000d', 'test-con-d', 'Constraints D');
INSERT INTO core.forms (id, workspace_id, form_key, name, allowed_origins, privacy_policy_version) VALUES
  ('0193cccc-0000-7000-8000-0000000000f1', '0193cccc-0000-7000-8000-00000000000c', 'frm_test_con', 'Constraints form', ARRAY['https://c.example.com'], '2026-11-03');
INSERT INTO crm.leads (id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name, area_of_expertise, first_submitted_at, last_submitted_at) VALUES
  ('0193cccc-0000-7000-8000-0000000000a1', '0193cccc-0000-7000-8000-00000000000c', 'Ana', 'Souza', 'ana@example.com', '+5511912345678', 'Empresa C', 'technology', now(), now());
INSERT INTO capture.submissions (id, workspace_id, form_id, lead_id, idempotency_key, request_hash, event_id, fields, consent_state, client_ip, user_agent, ip_hmac, antibot) VALUES
  ('0193cccc-0000-7000-8000-0000000000a2', '0193cccc-0000-7000-8000-00000000000c', '0193cccc-0000-7000-8000-0000000000f1', '0193cccc-0000-7000-8000-0000000000a1',
   '0193cccc-0000-7000-8000-0000000000a7', repeat('a', 64), '0193cccc-0000-7000-8000-0000000000a8', '{}',
   '{"analytics_storage":"denied","ad_storage":"denied","ad_user_data":"denied","ad_personalization":"denied"}',
   '203.0.113.7', 'test-agent', repeat('b', 64), '{"provider":"turnstile"}');
INSERT INTO tracking.outbox_events (id, workspace_id, aggregate_type, aggregate_id, event_type, payload) VALUES
  ('0193cccc-0000-7000-8000-0000000000a5', '0193cccc-0000-7000-8000-00000000000c', 'lead', '0193cccc-0000-7000-8000-0000000000a1', 'lead.captured', '{}');
INSERT INTO tracking.deliveries (id, outbox_event_id, workspace_id, destination) VALUES
  ('0193cccc-0000-7000-8000-0000000000a6', '0193cccc-0000-7000-8000-0000000000a5', '0193cccc-0000-7000-8000-00000000000c', 'meta_capi');

-- AC-DB-06: CHECK constraints on crm.leads (INSERT) ------------------------------------------------------------------

SELECT lives_ok(
  $$ INSERT INTO crm.leads (
       id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name, area_of_expertise,
       area_of_expertise_other, job_title, company_size, company_website, stage, score, score_band,
       score_breakdown, marketing_opt_in, submissions_count, first_touch, last_touch,
       first_submitted_at, last_submitted_at)
     VALUES (
       '0193cccc-0000-7000-8000-0000000000a9', '0193cccc-0000-7000-8000-00000000000c', 'Maria', 'D''Ávila-Souza',
       'maria@empresa.com.br', '+5511912345679', 'Empresa & Cia', 'other', 'Biotecnologia', 'Head de Marketing',
       '51_200', 'https://empresa.com.br', 'qualified', 72, 'A', '[{"rule_id":"fit_size","points":20}]', true, 2,
       '{"utm_source":"meta"}', '{"utm_source":"google"}', now(), now()) $$,
  'a fully populated, valid lead is accepted'
);

SELECT throws_ok(
  $$ INSERT INTO crm.leads (id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name, area_of_expertise, first_submitted_at, last_submitted_at)
     VALUES ('0193cccc-0000-7000-8000-0000000000b1', '0193cccc-0000-7000-8000-00000000000c', 'Maria', 'Silva', 'Maria@Example.com', '+5511912345670', 'Empresa', 'technology', now(), now()) $$,
  '23514', 'new row for relation "leads" violates check constraint "leads_email_lowercase_check"',
  'AC-DB-06: an e-mail with upper-case letters is rejected'
);
SELECT throws_ok(
  $$ INSERT INTO crm.leads (id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name, area_of_expertise, first_submitted_at, last_submitted_at)
     VALUES ('0193cccc-0000-7000-8000-0000000000b2', '0193cccc-0000-7000-8000-00000000000c', 'Maria', 'Silva', 'maria2@example.com', '11912345670', 'Empresa', 'technology', now(), now()) $$,
  '23514', 'new row for relation "leads" violates check constraint "leads_whatsapp_e164_check"',
  'AC-DB-06: a WhatsApp number outside E.164 is rejected'
);
SELECT throws_ok(
  $$ INSERT INTO crm.leads (id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name, area_of_expertise, stage, first_submitted_at, last_submitted_at)
     VALUES ('0193cccc-0000-7000-8000-0000000000b3', '0193cccc-0000-7000-8000-00000000000c', 'Maria', 'Silva', 'maria3@example.com', '+5511912345670', 'Empresa', 'technology', 'archived', now(), now()) $$,
  '23514', 'new row for relation "leads" violates check constraint "leads_stage_check"',
  'AC-DB-06: an unknown stage is rejected'
);
SELECT throws_ok(
  $$ INSERT INTO crm.leads (id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name, area_of_expertise, stage, first_submitted_at, last_submitted_at)
     VALUES ('0193cccc-0000-7000-8000-0000000000b4', '0193cccc-0000-7000-8000-00000000000c', 'Maria', 'Silva', 'maria4@example.com', '+5511912345670', 'Empresa', 'technology', 'lost', now(), now()) $$,
  '23514', 'new row for relation "leads" violates check constraint "leads_lost_reason_consistency_check"',
  'AC-DB-06: stage lost without lost_reason is rejected'
);

SELECT lives_ok(
  $$ UPDATE crm.leads SET stage = 'lost', lost_reason = 'no_budget' WHERE id = '0193cccc-0000-7000-8000-0000000000a1' $$,
  'stage lost with a valid lost_reason is accepted'
);
SELECT throws_ok(
  $$ UPDATE crm.leads SET lost_reason = 'whatever' WHERE id = '0193cccc-0000-7000-8000-0000000000a1' $$,
  '23514', 'new row for relation "leads" violates check constraint "leads_lost_reason_check"',
  'an unknown lost_reason is rejected'
);
SELECT throws_ok(
  $$ UPDATE crm.leads SET stage = 'contacted' WHERE id = '0193cccc-0000-7000-8000-0000000000a1' $$,
  '23514', 'new row for relation "leads" violates check constraint "leads_lost_reason_consistency_check"',
  'leaving stage lost without clearing lost_reason is rejected'
);
SELECT lives_ok(
  $$ UPDATE crm.leads SET stage = 'contacted', lost_reason = NULL WHERE id = '0193cccc-0000-7000-8000-0000000000a1' $$,
  'reopening a lost lead (stage and lost_reason together) is accepted'
);

SELECT throws_ok(
  $$ UPDATE crm.leads SET area_of_expertise = 'other' WHERE id = '0193cccc-0000-7000-8000-0000000000a1' $$,
  '23514', 'new row for relation "leads" violates check constraint "leads_area_of_expertise_other_consistency_check"',
  'area other without area_of_expertise_other is rejected'
);
SELECT throws_ok(
  $$ UPDATE crm.leads SET area_of_expertise_other = 'Astrologia' WHERE id = '0193cccc-0000-7000-8000-0000000000a1' $$,
  '23514', 'new row for relation "leads" violates check constraint "leads_area_of_expertise_other_consistency_check"',
  'area_of_expertise_other with an area other than "other" is rejected'
);
SELECT throws_ok(
  $$ UPDATE crm.leads SET area_of_expertise = 'astrology' WHERE id = '0193cccc-0000-7000-8000-0000000000a1' $$,
  '23514', 'new row for relation "leads" violates check constraint "leads_area_of_expertise_check"',
  'an area outside the lead-capture enum is rejected'
);
SELECT throws_ok(
  $$ UPDATE crm.leads SET company_size = '5' WHERE id = '0193cccc-0000-7000-8000-0000000000a1' $$,
  '23514', 'new row for relation "leads" violates check constraint "leads_company_size_check"',
  'a company size outside the enum is rejected'
);
SELECT throws_ok(
  $$ UPDATE crm.leads SET company_website = 'ftp://empresa.com.br' WHERE id = '0193cccc-0000-7000-8000-0000000000a1' $$,
  '23514', 'new row for relation "leads" violates check constraint "leads_company_website_check"',
  'a non-http(s) website is rejected'
);
SELECT throws_ok(
  $$ UPDATE crm.leads SET email = 'a b@example.com' WHERE id = '0193cccc-0000-7000-8000-0000000000a1' $$,
  '23514', 'new row for relation "leads" violates check constraint "leads_email_format_check"',
  'an e-mail with whitespace is rejected'
);
SELECT throws_ok(
  $$ UPDATE crm.leads SET first_name = repeat('a', 61) WHERE id = '0193cccc-0000-7000-8000-0000000000a1' $$,
  '23514', 'new row for relation "leads" violates check constraint "leads_first_name_length_check"',
  'a first name longer than 60 characters is rejected'
);
SELECT throws_ok(
  $$ UPDATE crm.leads SET score = 101 WHERE id = '0193cccc-0000-7000-8000-0000000000a1' $$,
  '23514', 'new row for relation "leads" violates check constraint "leads_score_range_check"',
  'a score above 100 is rejected'
);
SELECT throws_ok(
  $$ UPDATE crm.leads SET score_band = 'D' WHERE id = '0193cccc-0000-7000-8000-0000000000a1' $$,
  '23514', 'new row for relation "leads" violates check constraint "leads_score_band_check"',
  'a score band outside A/B/C is rejected'
);
SELECT throws_ok(
  $$ UPDATE crm.leads SET score_breakdown = '{}' WHERE id = '0193cccc-0000-7000-8000-0000000000a1' $$,
  '23514', 'new row for relation "leads" violates check constraint "leads_score_breakdown_array_check"',
  'a score breakdown that is not a JSON array is rejected'
);
SELECT throws_ok(
  $$ UPDATE crm.leads SET submissions_count = 0 WHERE id = '0193cccc-0000-7000-8000-0000000000a1' $$,
  '23514', 'new row for relation "leads" violates check constraint "leads_submissions_count_check"',
  'submissions_count below 1 is rejected'
);

-- AC-DB-07: dedupe by (workspace_id, email) among active leads ---------------------------------------------------------

SELECT lives_ok(
  $$ INSERT INTO crm.leads (id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name, area_of_expertise, first_submitted_at, last_submitted_at)
     VALUES ('0193cccc-0000-7000-8000-0000000000d1', '0193cccc-0000-7000-8000-00000000000c', 'Dani', 'Alves', 'dup@example.com', '+5511911110001', 'Empresa D', 'finance', now(), now())
     ON CONFLICT (workspace_id, email) WHERE anonymized_at IS NULL DO NOTHING $$,
  'AC-DB-07: first INSERT ... ON CONFLICT creates the lead'
);
SELECT lives_ok(
  $$ INSERT INTO crm.leads (id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name, area_of_expertise, first_submitted_at, last_submitted_at)
     VALUES ('0193cccc-0000-7000-8000-0000000000d2', '0193cccc-0000-7000-8000-00000000000c', 'Dani', 'Alves', 'dup@example.com', '+5511911110001', 'Empresa D', 'finance', now(), now())
     ON CONFLICT (workspace_id, email) WHERE anonymized_at IS NULL DO NOTHING $$,
  'AC-DB-07: the second INSERT ... ON CONFLICT DO NOTHING is absorbed'
);
SELECT is(
  (SELECT count(*) FROM crm.leads WHERE workspace_id = '0193cccc-0000-7000-8000-00000000000c' AND email = 'dup@example.com'),
  1::bigint,
  'AC-DB-07: two inserts with the same e-mail result in one lead'
);
SELECT lives_ok(
  $$ INSERT INTO crm.leads (id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name, area_of_expertise, first_submitted_at, last_submitted_at)
     VALUES ('0193cccc-0000-7000-8000-0000000000d3', '0193cccc-0000-7000-8000-00000000000c', 'Dani', 'Alves', 'dup@example.com', '+5511911110001', 'Empresa D', 'finance', now(), now())
     ON CONFLICT (workspace_id, email) WHERE anonymized_at IS NULL
     DO UPDATE SET submissions_count = crm.leads.submissions_count + 1, version = crm.leads.version + 1 $$,
  'AC-DB-07: ON CONFLICT DO UPDATE resolves to the existing lead'
);
SELECT results_eq(
  $$ SELECT submissions_count, version, count(*) OVER () FROM crm.leads WHERE email = 'dup@example.com' $$,
  $$ VALUES (2, 2, 1::bigint) $$,
  'AC-DB-07: the upsert incremented the existing lead instead of creating another'
);
SELECT throws_ok(
  $$ INSERT INTO crm.leads (id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name, area_of_expertise, first_submitted_at, last_submitted_at)
     VALUES ('0193cccc-0000-7000-8000-0000000000d4', '0193cccc-0000-7000-8000-00000000000c', 'Dani', 'Alves', 'dup@example.com', '+5511911110001', 'Empresa D', 'finance', now(), now()) $$,
  '23505', 'duplicate key value violates unique constraint "leads_workspace_email_active_key"',
  'AC-DB-07: a plain duplicate INSERT is rejected by the unique index'
);
SELECT lives_ok(
  $$ INSERT INTO crm.leads (id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name, area_of_expertise, first_submitted_at, last_submitted_at)
     VALUES ('0193cccc-0000-7000-8000-0000000000d5', '0193cccc-0000-7000-8000-00000000000d', 'Dani', 'Alves', 'dup@example.com', '+5511911110001', 'Empresa D', 'finance', now(), now()) $$,
  'the same e-mail is allowed in another workspace'
);

-- AC-DB-08: an anonymized lead releases its e-mail ---------------------------------------------------------------------

SELECT lives_ok(
  $$ INSERT INTO crm.leads (id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name, area_of_expertise, first_submitted_at, last_submitted_at)
     VALUES ('0193cccc-0000-7000-8000-0000000000e1', '0193cccc-0000-7000-8000-00000000000c', 'Eva', 'Costa', 'eva@example.com', '+5511911110002', 'Empresa E', 'health', now(), now()) $$,
  'fixture: lead to be anonymized'
);
SELECT lives_ok(
  $$ UPDATE crm.leads
     SET anonymized_at = now(), first_name = 'Anonymized', last_name = 'Anonymized',
         email = 'anon+0193cccc-0000-7000-8000-0000000000e1@anonymized.invalid',
         whatsapp_e164 = '+10000000000', company_name = 'Anonymized', company_website = NULL
     WHERE id = '0193cccc-0000-7000-8000-0000000000e1' $$,
  'AC-DB-08: the anonymized replacement values satisfy every CHECK'
);
SELECT lives_ok(
  $$ INSERT INTO crm.leads (id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name, area_of_expertise, first_submitted_at, last_submitted_at)
     VALUES ('0193cccc-0000-7000-8000-0000000000e2', '0193cccc-0000-7000-8000-00000000000c', 'Eva', 'Costa', 'eva@example.com', '+5511911110002', 'Empresa E', 'health', now(), now()) $$,
  'AC-DB-08: the e-mail of an anonymized lead can start a new lead'
);
SELECT is(
  (SELECT count(*) FROM crm.leads WHERE workspace_id = '0193cccc-0000-7000-8000-00000000000c' AND email = 'eva@example.com'),
  1::bigint,
  'AC-DB-08: exactly one lead holds the e-mail again'
);

SELECT lives_ok(
  $$ INSERT INTO crm.leads (id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name, area_of_expertise, anonymized_at, first_submitted_at, last_submitted_at)
     VALUES ('0193cccc-0000-7000-8000-0000000000e3', '0193cccc-0000-7000-8000-00000000000c', 'Flo', 'Dias', 'flag@example.com', '+5511911110003', 'Empresa F', 'health', now(), now(), now()) $$,
  'fixture: lead flagged anonymized but still carrying the e-mail'
);
SELECT lives_ok(
  $$ INSERT INTO crm.leads (id, workspace_id, first_name, last_name, email, whatsapp_e164, company_name, area_of_expertise, first_submitted_at, last_submitted_at)
     VALUES ('0193cccc-0000-7000-8000-0000000000e4', '0193cccc-0000-7000-8000-00000000000c', 'Flo', 'Dias', 'flag@example.com', '+5511911110003', 'Empresa F', 'health', now(), now()) $$,
  'AC-DB-08: the unique index is partial - anonymized_at alone releases the e-mail'
);

-- updated_at trigger -------------------------------------------------------------------------------------------------------

INSERT INTO core.workspaces (id, slug, name, created_at, updated_at) VALUES
  ('0193cccc-0000-7000-8000-0000000000aa', 'test-con-old', 'Old', '2020-01-01', '2020-01-01');
UPDATE core.workspaces SET name = 'Renamed' WHERE id = '0193cccc-0000-7000-8000-0000000000aa';
SELECT cmp_ok(
  (SELECT updated_at FROM core.workspaces WHERE id = '0193cccc-0000-7000-8000-0000000000aa'),
  '>', '2024-01-01'::timestamptz,
  'updated_at is refreshed by trigger on UPDATE'
);
UPDATE core.workspaces SET name = 'Renamed again', updated_at = '2021-01-01' WHERE id = '0193cccc-0000-7000-8000-0000000000aa';
SELECT cmp_ok(
  (SELECT updated_at FROM core.workspaces WHERE id = '0193cccc-0000-7000-8000-0000000000aa'),
  '>', '2024-01-01'::timestamptz,
  'a caller cannot override updated_at'
);

-- core.workspaces / core.forms -------------------------------------------------------------------------------------------------

SELECT throws_ok(
  $$ INSERT INTO core.workspaces (id, slug, name) VALUES ('0193cccc-0000-7000-8000-0000000000ab', 'Bad Slug', 'x') $$,
  '23514', 'new row for relation "workspaces" violates check constraint "workspaces_slug_format_check"',
  'a workspace slug must be lowercase kebab-case'
);
SELECT throws_ok(
  $$ INSERT INTO core.workspaces (id, slug, name) VALUES ('0193cccc-0000-7000-8000-0000000000ac', 'test-con-c', 'dup') $$,
  '23505', 'duplicate key value violates unique constraint "workspaces_slug_key"',
  'a workspace slug is unique'
);
SELECT throws_ok(
  $$ UPDATE core.forms SET form_key = 'lp_main' WHERE id = '0193cccc-0000-7000-8000-0000000000f1' $$,
  '23514', 'new row for relation "forms" violates check constraint "forms_form_key_format_check"',
  'a form_key must start with frm_'
);
SELECT throws_ok(
  $$ UPDATE core.forms SET status = 'deleted' WHERE id = '0193cccc-0000-7000-8000-0000000000f1' $$,
  '23514', 'new row for relation "forms" violates check constraint "forms_status_check"',
  'a form status outside active/paused/archived is rejected'
);
SELECT throws_ok(
  $$ UPDATE core.forms SET allowed_origins = ARRAY['http://example.com'] WHERE id = '0193cccc-0000-7000-8000-0000000000f1' $$,
  '23514', 'new row for relation "forms" violates check constraint "forms_allowed_origins_check"',
  'a plain-http non-loopback origin is rejected'
);
SELECT throws_ok(
  $$ UPDATE core.forms SET allowed_origins = ARRAY['http://localhost.evil.com'] WHERE id = '0193cccc-0000-7000-8000-0000000000f1' $$,
  '23514', 'new row for relation "forms" violates check constraint "forms_allowed_origins_check"',
  'a look-alike localhost origin is rejected'
);
SELECT throws_ok(
  $$ UPDATE core.forms SET allowed_origins = ARRAY['https://Example.com'] WHERE id = '0193cccc-0000-7000-8000-0000000000f1' $$,
  '23514', 'new row for relation "forms" violates check constraint "forms_allowed_origins_check"',
  'an origin with upper-case letters is rejected'
);
SELECT throws_ok(
  $$ UPDATE core.forms SET allowed_origins = ARRAY['https://example.com/path'] WHERE id = '0193cccc-0000-7000-8000-0000000000f1' $$,
  '23514', 'new row for relation "forms" violates check constraint "forms_allowed_origins_check"',
  'an origin with a path is rejected'
);
SELECT lives_ok(
  $$ UPDATE core.forms SET allowed_origins = ARRAY['https://www.example.com.br', 'https://lp.example.com:8443', 'http://localhost', 'http://localhost:4321', 'http://127.0.0.1:4321']
     WHERE id = '0193cccc-0000-7000-8000-0000000000f1' $$,
  'https origins and http loopback origins are accepted'
);
SELECT throws_ok(
  $$ UPDATE core.forms SET privacy_policy_version = '03/11/2026' WHERE id = '0193cccc-0000-7000-8000-0000000000f1' $$,
  '23514', 'new row for relation "forms" violates check constraint "forms_privacy_policy_version_check"',
  'a policy version must be YYYY-MM-DD[.n]'
);
SELECT throws_ok(
  $$ UPDATE core.forms SET turnstile_action = 'Lead Submit' WHERE id = '0193cccc-0000-7000-8000-0000000000f1' $$,
  '23514', 'new row for relation "forms" violates check constraint "forms_turnstile_action_check"',
  'a Turnstile action must be lowercase snake_case'
);

-- capture.submissions ---------------------------------------------------------------------------------------------------------------

SELECT throws_ok(
  $$ UPDATE capture.submissions SET request_hash = 'not-a-sha256' WHERE id = '0193cccc-0000-7000-8000-0000000000a2' $$,
  '23514', 'new row for relation "submissions" violates check constraint "submissions_request_hash_check"',
  'request_hash must be 64 lowercase hex characters'
);
SELECT throws_ok(
  $$ UPDATE capture.submissions SET consent_state = '{"analytics_storage":"granted"}' WHERE id = '0193cccc-0000-7000-8000-0000000000a2' $$,
  '23514', 'new row for relation "submissions" violates check constraint "submissions_consent_state_check"',
  'consent_state with missing signals is rejected (NULL-safe)'
);
SELECT throws_ok(
  $$ UPDATE capture.submissions
     SET consent_state = '{"analytics_storage":"maybe","ad_storage":"denied","ad_user_data":"denied","ad_personalization":"denied"}'
     WHERE id = '0193cccc-0000-7000-8000-0000000000a2' $$,
  '23514', 'new row for relation "submissions" violates check constraint "submissions_consent_state_check"',
  'consent_state values must be granted or denied'
);
SELECT throws_ok(
  $$ UPDATE capture.submissions SET message = repeat('x', 1001) WHERE id = '0193cccc-0000-7000-8000-0000000000a2' $$,
  '23514', 'new row for relation "submissions" violates check constraint "submissions_message_length_check"',
  'a message longer than 1000 characters is rejected'
);
SELECT throws_ok(
  $$ UPDATE capture.submissions SET utm_source = repeat('x', 151) WHERE id = '0193cccc-0000-7000-8000-0000000000a2' $$,
  '23514', 'new row for relation "submissions" violates check constraint "submissions_utm_length_check"',
  'a UTM value longer than 150 characters is rejected'
);
SELECT throws_ok(
  $$ UPDATE capture.submissions SET gclid = repeat('x', 501) WHERE id = '0193cccc-0000-7000-8000-0000000000a2' $$,
  '23514', 'new row for relation "submissions" violates check constraint "submissions_click_id_length_check"',
  'a click id longer than 500 characters is rejected'
);
SELECT throws_ok(
  $$ UPDATE capture.submissions SET pii_purged_at = now() WHERE id = '0193cccc-0000-7000-8000-0000000000a2' $$,
  '23514', 'new row for relation "submissions" violates check constraint "submissions_pii_purge_consistency_check"',
  'a row cannot be marked purged while it still holds the raw IP or user agent'
);
SELECT lives_ok(
  $$ UPDATE capture.submissions SET client_ip = NULL, user_agent = NULL, pii_purged_at = now() WHERE id = '0193cccc-0000-7000-8000-0000000000a2' $$,
  'the PII purge (IP and user agent nulled, pii_purged_at set) is accepted'
);
SELECT throws_ok(
  $$ INSERT INTO capture.submissions (id, workspace_id, form_id, lead_id, idempotency_key, request_hash, event_id, fields, consent_state, ip_hmac, antibot)
     VALUES ('0193cccc-0000-7000-8000-0000000000b9', '0193cccc-0000-7000-8000-00000000000c', '0193cccc-0000-7000-8000-0000000000f1', '0193cccc-0000-7000-8000-0000000000a1',
       '0193cccc-0000-7000-8000-0000000000a7', repeat('a', 64), '0193cccc-0000-7000-8000-0000000000ba', '{}',
       '{"analytics_storage":"denied","ad_storage":"denied","ad_user_data":"denied","ad_personalization":"denied"}', repeat('b', 64), '{}') $$,
  '23505', 'duplicate key value violates unique constraint "submissions_idempotency_key_key"',
  'an idempotency key is unique per workspace'
);
SELECT throws_ok(
  $$ INSERT INTO capture.submissions (id, workspace_id, form_id, lead_id, idempotency_key, request_hash, event_id, fields, consent_state, ip_hmac, antibot)
     VALUES ('0193cccc-0000-7000-8000-0000000000bb', '0193cccc-0000-7000-8000-00000000000c', '0193cccc-0000-7000-8000-0000000000f1', '0193cccc-0000-7000-8000-0000000000a1',
       '0193cccc-0000-7000-8000-0000000000bc', repeat('a', 64), '0193cccc-0000-7000-8000-0000000000a8', '{}',
       '{"analytics_storage":"denied","ad_storage":"denied","ad_user_data":"denied","ad_personalization":"denied"}', repeat('b', 64), '{}') $$,
  '23505', 'duplicate key value violates unique constraint "submissions_event_id_key"',
  'a conversion event_id is unique per workspace'
);

-- capture.consents, crm.lead_activities, tracking.*, core.audit_log -------------------------------------------------------------------

SELECT throws_ok(
  $$ INSERT INTO capture.consents (id, workspace_id, lead_id, submission_id, purpose, granted, policy_version)
     VALUES ('0193cccc-0000-7000-8000-0000000000c3', '0193cccc-0000-7000-8000-00000000000c', '0193cccc-0000-7000-8000-0000000000a1', '0193cccc-0000-7000-8000-0000000000a2', 'sms', true, '2026-11-03') $$,
  '23514', 'new row for relation "consents" violates check constraint "consents_purpose_check"',
  'a consent purpose outside the known purposes is rejected'
);
SELECT throws_ok(
  $$ INSERT INTO crm.lead_activities (id, workspace_id, lead_id, type, actor_type)
     VALUES ('0193cccc-0000-7000-8000-0000000000c4', '0193cccc-0000-7000-8000-00000000000c', '0193cccc-0000-7000-8000-0000000000a1', 'deleted', 'system') $$,
  '23514', 'new row for relation "lead_activities" violates check constraint "lead_activities_type_check"',
  'an activity type outside the known types is rejected'
);
SELECT throws_ok(
  $$ INSERT INTO crm.lead_activities (id, workspace_id, lead_id, type, actor_type, data)
     VALUES ('0193cccc-0000-7000-8000-0000000000c5', '0193cccc-0000-7000-8000-00000000000c', '0193cccc-0000-7000-8000-0000000000a1', 'note_added', 'user', jsonb_build_object('k', repeat('x', 9000))) $$,
  '23514', 'new row for relation "lead_activities" violates check constraint "lead_activities_data_check"',
  'activity data above 8 KB is rejected'
);
SELECT throws_ok(
  $$ INSERT INTO tracking.outbox_events (id, workspace_id, aggregate_type, aggregate_id, event_type, payload, status)
     VALUES ('0193cccc-0000-7000-8000-0000000000c6', '0193cccc-0000-7000-8000-00000000000c', 'lead', '0193cccc-0000-7000-8000-0000000000a1', 'lead.captured', '{}', 'weird') $$,
  '23514', 'new row for relation "outbox_events" violates check constraint "outbox_events_status_check"',
  'an outbox status outside pending/processing/done/dead is rejected'
);
SELECT throws_ok(
  $$ INSERT INTO tracking.outbox_events (id, workspace_id, aggregate_type, aggregate_id, event_type, payload)
     VALUES ('0193cccc-0000-7000-8000-0000000000c7', '0193cccc-0000-7000-8000-00000000000c', 'lead', '0193cccc-0000-7000-8000-0000000000a1', 'lead.deleted', '{}') $$,
  '23514', 'new row for relation "outbox_events" violates check constraint "outbox_events_event_type_check"',
  'an outbox event type outside the known types is rejected'
);
SELECT throws_ok(
  $$ INSERT INTO tracking.deliveries (id, outbox_event_id, workspace_id, destination)
     VALUES ('0193cccc-0000-7000-8000-0000000000c8', '0193cccc-0000-7000-8000-0000000000a5', '0193cccc-0000-7000-8000-00000000000c', 'meta_capi') $$,
  '23505', 'duplicate key value violates unique constraint "deliveries_outbox_destination_key"',
  'a destination receives at most one delivery per outbox event'
);
SELECT throws_ok(
  $$ INSERT INTO tracking.deliveries (id, outbox_event_id, workspace_id, destination)
     VALUES ('0193cccc-0000-7000-8000-0000000000c9', '0193cccc-0000-7000-8000-0000000000a5', '0193cccc-0000-7000-8000-00000000000c', 'tiktok') $$,
  '23514', 'new row for relation "deliveries" violates check constraint "deliveries_destination_check"',
  'a delivery destination outside the known destinations is rejected'
);
SELECT throws_ok(
  $$ UPDATE tracking.deliveries SET last_http_status = 99 WHERE id = '0193cccc-0000-7000-8000-0000000000a6' $$,
  '23514', 'new row for relation "deliveries" violates check constraint "deliveries_last_http_status_check"',
  'an HTTP status outside 100-599 is rejected'
);
SELECT throws_ok(
  $$ INSERT INTO core.audit_log (workspace_id, actor_type, action, resource_type, result, correlation_id)
     VALUES ('0193cccc-0000-7000-8000-00000000000c', 'system', 'lead.created', 'lead', 'maybe', '0193cccc-0000-7000-8000-0000000000c1') $$,
  '23514', 'new row for relation "audit_log" violates check constraint "audit_log_result_check"',
  'an audit result outside success/denied/error is rejected'
);
SELECT throws_ok(
  $$ INSERT INTO core.audit_log (workspace_id, actor_type, action, resource_type, result, correlation_id)
     VALUES ('0193cccc-0000-7000-8000-00000000000c', 'robot', 'lead.created', 'lead', 'success', '0193cccc-0000-7000-8000-0000000000c1') $$,
  '23514', 'new row for relation "audit_log" violates check constraint "audit_log_actor_type_check"',
  'an audit actor type outside system/user/qstash/ai is rejected'
);
SELECT lives_ok(
  $$ INSERT INTO core.audit_log (workspace_id, actor_type, action, resource_type, resource_id, result, correlation_id)
     VALUES ('0193cccc-0000-7000-8000-00000000000c', 'qstash', 'outbox.dispatched', 'outbox_event', '0193cccc-0000-7000-8000-0000000000a5', 'success', '0193cccc-0000-7000-8000-0000000000c1') $$,
  'a valid audit entry gets its identity id generated'
);

SELECT * FROM finish();
ROLLBACK;
