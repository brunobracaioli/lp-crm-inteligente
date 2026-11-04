-- Wave 1 - core schema (docs/specs/database.md sections 1-5; ADR-0003, ADR-0006).
--
-- Private schemas per bounded context, CHECK constraints mirroring lead-capture/crm field rules,
-- append-only guards, RLS ENABLE + FORCE on every table and the least-privilege runtime role `lp_api`.
--
-- Conventions:
--   * No secrets here. The `lp_api` password is set out-of-band (docs/how-to/rotate-db-role-password.md).
--   * No dynamic SQL (Semgrep rule no-dynamic-sql-in-migrations).
--   * A CHECK constraint passes when its expression is NULL, so nullable columns need no IS NULL guard.
--   * Parent/child links are composite, (workspace_id, <parent>_id) -> parent (workspace_id, id): foreign-key
--     checks bypass RLS, so this is the only barrier that stops a child row from pointing at another
--     workspace's parent. Every referenced parent therefore carries UNIQUE (workspace_id, id).
--   * Migrations are immutable: fix forward with a new migration.

-- ---------------------------------------------------------------------------
-- 1. Runtime role. Roles are cluster-wide and survive `supabase db reset`, so creation is idempotent.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'lp_api') THEN
    CREATE ROLE lp_api LOGIN NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE CONNECTION LIMIT 20;
  END IF;
END
$$;

-- Re-assert the attributes (drift correction). No PASSWORD clause on purpose.
ALTER ROLE lp_api WITH LOGIN NOINHERIT NOBYPASSRLS NOCREATEDB NOCREATEROLE CONNECTION LIMIT 20;
ALTER ROLE lp_api SET statement_timeout = '3s';
ALTER ROLE lp_api SET idle_in_transaction_session_timeout = '5s';
-- Everything the runtime touches is fully qualified; an empty path also defeats search_path hijacking.
ALTER ROLE lp_api SET search_path = '';

COMMENT ON ROLE lp_api IS 'Runtime role of the API (ADR-0003): no DDL, no DELETE, no BYPASSRLS; password set out-of-band.';

-- ---------------------------------------------------------------------------
-- 2. Schemas (never exposed by the Data API: supabase/config.toml [api] schemas = ["public"])
-- ---------------------------------------------------------------------------

CREATE SCHEMA core;
CREATE SCHEMA crm;
CREATE SCHEMA capture;
CREATE SCHEMA tracking;

COMMENT ON SCHEMA core IS 'Shared kernel: workspaces, forms, audit log. Private (not exposed by the Data API).';
COMMENT ON SCHEMA crm IS 'CRM bounded context: leads and their activity timeline. Private.';
COMMENT ON SCHEMA capture IS 'Lead-capture bounded context: submissions and consents. Private.';
COMMENT ON SCHEMA tracking IS 'Tracking bounded context: transactional outbox and deliveries. Private.';

-- Deny by default: nobody but the owner and lp_api (granted below) can even resolve names in these schemas.
REVOKE ALL ON SCHEMA core, crm, capture, tracking FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Helper functions (all SECURITY INVOKER with an empty search_path)
-- ---------------------------------------------------------------------------

-- Workspace of the current transaction, set by the API with
-- SELECT set_config('app.workspace_id', $1, true) at the start of every transaction.
-- NULLIF matters: after a transaction-local set_config the GUC reads back as '' (not NULL) on a reused
-- pooled connection, and ''::uuid would raise instead of matching no rows.
CREATE FUNCTION core.current_workspace_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
$$;

COMMENT ON FUNCTION core.current_workspace_id() IS
  'Workspace id from the transaction-local setting app.workspace_id; NULL (no rows visible) when unset or empty.';

CREATE FUNCTION core.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION core.set_updated_at() IS 'BEFORE UPDATE trigger: keeps updated_at authoritative (callers cannot set it).';

CREATE FUNCTION core.reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'append-only table: % on %.% is not allowed', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

COMMENT ON FUNCTION core.reject_mutation() IS
  'BEFORE UPDATE/DELETE/TRUNCATE trigger for append-only tables (consents, lead activities, audit log).';

-- Each origin: https://host[:port] or, for local development only, http://localhost / http://127.0.0.1.
CREATE FUNCTION core.is_valid_origin_list(origins text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT origins IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(origins) AS o (origin)
      WHERE o.origin IS NULL
        OR o.origin !~ '^(https://[a-z0-9.-]+|http://(localhost|127\.0\.0\.1))(:[0-9]+)?$'
    )
$$;

COMMENT ON FUNCTION core.is_valid_origin_list(text[]) IS
  'CHECK helper for core.forms.allowed_origins: https origins plus http loopback origins for local development.';

REVOKE ALL ON FUNCTION core.current_workspace_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION core.set_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION core.reject_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION core.is_valid_origin_list(text[]) FROM PUBLIC;
-- RLS policy expressions run with the privileges of the querying role.
GRANT EXECUTE ON FUNCTION core.current_workspace_id() TO lp_api;

-- ---------------------------------------------------------------------------
-- 4. Tables
-- ---------------------------------------------------------------------------

-- 4.1 core.workspaces -------------------------------------------------------

CREATE TABLE core.workspaces (
  id uuid PRIMARY KEY,
  slug text NOT NULL,
  name text NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspaces_slug_key UNIQUE (slug),
  CONSTRAINT workspaces_slug_format_check CHECK (slug ~ '^[a-z0-9-]{3,40}$'),
  CONSTRAINT workspaces_name_length_check CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT workspaces_settings_object_check CHECK (jsonb_typeof(settings) = 'object')
);

COMMENT ON TABLE core.workspaces IS 'Tenant root (ADR-0006). v1 operates a single seeded workspace; settings.icp holds the score weights.';
COMMENT ON INDEX core.workspaces_slug_key IS 'Workspace lookup by slug.';

-- 4.2 core.forms ------------------------------------------------------------

CREATE TABLE core.forms (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES core.workspaces (id),
  form_key text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  allowed_origins text[] NOT NULL,
  turnstile_action text NOT NULL DEFAULT 'lead_submit',
  privacy_policy_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT forms_form_key_key UNIQUE (form_key),
  CONSTRAINT forms_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT forms_form_key_format_check CHECK (form_key ~ '^frm_[a-z0-9_]{3,40}$'),
  CONSTRAINT forms_name_length_check CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT forms_status_check CHECK (status IN ('active', 'paused', 'archived')),
  CONSTRAINT forms_allowed_origins_check CHECK (core.is_valid_origin_list(allowed_origins)),
  CONSTRAINT forms_turnstile_action_check CHECK (turnstile_action ~ '^[a-z0-9_]{1,32}$'),
  CONSTRAINT forms_privacy_policy_version_check
    CHECK (privacy_policy_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[0-9]+)?$')
);

COMMENT ON TABLE core.forms IS 'Public form definitions. form_key is the public identifier used to route a submission to its workspace.';
COMMENT ON INDEX core.forms_form_key_key IS 'Form lookup by public form_key (step 5 of the lead-capture flow).';
COMMENT ON INDEX core.forms_workspace_id_id_key IS 'Target of the composite foreign key from capture.submissions (tenant-safe reference).';

-- 4.3 crm.leads (Lead aggregate) -------------------------------------------

CREATE TABLE crm.leads (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES core.workspaces (id),
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text NOT NULL,
  whatsapp_e164 text NOT NULL,
  company_name text NOT NULL,
  area_of_expertise text NOT NULL,
  area_of_expertise_other text,
  job_title text,
  company_size text,
  company_website text,
  stage text NOT NULL DEFAULT 'new',
  lost_reason text,
  score smallint NOT NULL DEFAULT 0,
  score_band text NOT NULL DEFAULT 'C',
  score_breakdown jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Logical reference to auth.users (wave 9); deliberately not a foreign key.
  owner_user_id uuid,
  marketing_opt_in boolean NOT NULL DEFAULT false,
  submissions_count integer NOT NULL DEFAULT 1,
  first_touch jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_touch jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_submitted_at timestamptz NOT NULL,
  last_submitted_at timestamptz NOT NULL,
  anonymized_at timestamptz,
  -- Optimistic lock: mutations compare and bump it (expected_version).
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leads_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT leads_first_name_length_check CHECK (char_length(first_name) BETWEEN 1 AND 60),
  CONSTRAINT leads_last_name_length_check CHECK (char_length(last_name) BETWEEN 1 AND 80),
  CONSTRAINT leads_email_length_check CHECK (char_length(email) <= 254),
  CONSTRAINT leads_email_lowercase_check CHECK (email = lower(email)),
  CONSTRAINT leads_email_format_check CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  CONSTRAINT leads_whatsapp_e164_check CHECK (whatsapp_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT leads_company_name_length_check CHECK (char_length(company_name) BETWEEN 2 AND 120),
  CONSTRAINT leads_area_of_expertise_check CHECK (
    area_of_expertise IN (
      'marketing_advertising', 'technology', 'ecommerce_retail', 'infoproducts_creators', 'health',
      'education', 'finance', 'real_estate', 'industry', 'professional_services', 'legal',
      'agribusiness', 'logistics', 'food_hospitality', 'construction', 'public_sector_nonprofit',
      'other'
    )
  ),
  CONSTRAINT leads_area_of_expertise_other_length_check
    CHECK (char_length(area_of_expertise_other) BETWEEN 2 AND 80),
  CONSTRAINT leads_area_of_expertise_other_consistency_check
    CHECK ((area_of_expertise = 'other') = (area_of_expertise_other IS NOT NULL)),
  CONSTRAINT leads_job_title_length_check CHECK (char_length(job_title) BETWEEN 2 AND 100),
  CONSTRAINT leads_company_size_check
    CHECK (company_size IN ('solo', '2_10', '11_50', '51_200', '201_1000', '1000_plus')),
  CONSTRAINT leads_company_website_check
    CHECK (char_length(company_website) <= 200 AND company_website ~ '^https?://'),
  CONSTRAINT leads_stage_check
    CHECK (stage IN ('new', 'contacted', 'qualified', 'proposal', 'won', 'lost')),
  CONSTRAINT leads_lost_reason_check CHECK (
    lost_reason IN (
      'no_budget', 'no_fit', 'no_response', 'chose_competitor', 'timing', 'invalid_contact',
      'duplicate', 'other'
    )
  ),
  CONSTRAINT leads_lost_reason_consistency_check CHECK ((stage = 'lost') = (lost_reason IS NOT NULL)),
  CONSTRAINT leads_score_range_check CHECK (score BETWEEN 0 AND 100),
  CONSTRAINT leads_score_band_check CHECK (score_band IN ('A', 'B', 'C')),
  CONSTRAINT leads_score_breakdown_array_check CHECK (jsonb_typeof(score_breakdown) = 'array'),
  CONSTRAINT leads_submissions_count_check CHECK (submissions_count >= 1),
  CONSTRAINT leads_first_touch_object_check CHECK (jsonb_typeof(first_touch) = 'object'),
  CONSTRAINT leads_last_touch_object_check CHECK (jsonb_typeof(last_touch) = 'object'),
  CONSTRAINT leads_version_check CHECK (version >= 1)
);

COMMENT ON TABLE crm.leads IS 'Lead aggregate root: one active row per (workspace_id, email). Contact fields are PII.';
COMMENT ON COLUMN crm.leads.owner_user_id IS 'Logical reference to auth.users.id (wave 9); not a foreign key.';
COMMENT ON COLUMN crm.leads.version IS 'Optimistic lock: UPDATE ... WHERE version = expected_version, then version + 1.';
COMMENT ON INDEX crm.leads_workspace_id_id_key IS
  'Target of the composite foreign keys from submissions, consents and lead activities (tenant-safe reference).';
COMMENT ON COLUMN crm.leads.anonymized_at IS 'LGPD: set by crm.anonymize_lead (wave 6); an anonymized lead leaves the active e-mail unique index.';

-- Dedupe (R1) and conflict target of INSERT ... ON CONFLICT (workspace_id, email) WHERE anonymized_at IS NULL.
CREATE UNIQUE INDEX leads_workspace_email_active_key
  ON crm.leads (workspace_id, email)
  WHERE anonymized_at IS NULL;
COMMENT ON INDEX crm.leads_workspace_email_active_key IS
  'Dedupe (R1) and ON CONFLICT target: one active lead per e-mail and workspace; anonymized leads release the e-mail.';

CREATE INDEX leads_pipeline_idx ON crm.leads (workspace_id, stage, created_at DESC, id);
COMMENT ON INDEX crm.leads_pipeline_idx IS 'Pipeline listing by stage with cursor pagination (created_at DESC, id).';

CREATE INDEX leads_owner_stage_idx ON crm.leads (workspace_id, owner_user_id, stage);
COMMENT ON INDEX crm.leads_owner_stage_idx IS '"My leads" view: leads of one owner grouped by stage.';

CREATE INDEX leads_whatsapp_idx ON crm.leads (workspace_id, whatsapp_e164);
COMMENT ON INDEX crm.leads_whatsapp_idx IS 'Lookup by phone number and secondary dedupe.';

CREATE INDEX leads_score_band_idx ON crm.leads (workspace_id, score_band, created_at DESC);
COMMENT ON INDEX crm.leads_score_band_idx IS 'Hot-leads queue: newest leads of a score band.';

-- 4.4 capture.submissions ---------------------------------------------------

CREATE TABLE capture.submissions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES core.workspaces (id),
  form_id uuid NOT NULL,
  lead_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  event_id uuid NOT NULL,
  fields jsonb NOT NULL,
  message text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_term text,
  utm_content text,
  utm_id text,
  gclid text,
  gbraid text,
  wbraid text,
  fbclid text,
  ttclid text,
  msclkid text,
  fbp text,
  fbc text,
  ga_client_id text,
  landing_page_url text,
  referrer_url text,
  consent_state jsonb NOT NULL,
  client_ip inet,
  user_agent text,
  ip_hmac text NOT NULL,
  antibot jsonb NOT NULL,
  pii_purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT submissions_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT submissions_form_fkey FOREIGN KEY (workspace_id, form_id) REFERENCES core.forms (workspace_id, id),
  CONSTRAINT submissions_lead_fkey FOREIGN KEY (workspace_id, lead_id) REFERENCES crm.leads (workspace_id, id),
  CONSTRAINT submissions_idempotency_key_key UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT submissions_event_id_key UNIQUE (workspace_id, event_id),
  CONSTRAINT submissions_request_hash_check CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT submissions_fields_object_check CHECK (jsonb_typeof(fields) = 'object'),
  CONSTRAINT submissions_message_length_check CHECK (char_length(message) <= 1000),
  CONSTRAINT submissions_utm_length_check CHECK (
    char_length(utm_source) <= 150 AND char_length(utm_medium) <= 150
    AND char_length(utm_campaign) <= 150 AND char_length(utm_term) <= 150
    AND char_length(utm_content) <= 150 AND char_length(utm_id) <= 150
  ),
  CONSTRAINT submissions_click_id_length_check CHECK (
    char_length(gclid) <= 500 AND char_length(gbraid) <= 500 AND char_length(wbraid) <= 500
    AND char_length(fbclid) <= 500 AND char_length(ttclid) <= 500 AND char_length(msclkid) <= 500
  ),
  CONSTRAINT submissions_meta_cookie_length_check
    CHECK (char_length(fbp) <= 500 AND char_length(fbc) <= 500),
  CONSTRAINT submissions_ga_client_id_length_check CHECK (char_length(ga_client_id) <= 100),
  CONSTRAINT submissions_url_length_check
    CHECK (char_length(landing_page_url) <= 2000 AND char_length(referrer_url) <= 2000),
  -- ?& is never NULL, so a missing key fails the check instead of slipping through as NULL.
  CONSTRAINT submissions_consent_state_check CHECK (
    jsonb_typeof(consent_state) = 'object'
    AND consent_state ?& ARRAY['analytics_storage', 'ad_storage', 'ad_user_data', 'ad_personalization']
    AND consent_state ->> 'analytics_storage' IN ('granted', 'denied')
    AND consent_state ->> 'ad_storage' IN ('granted', 'denied')
    AND consent_state ->> 'ad_user_data' IN ('granted', 'denied')
    AND consent_state ->> 'ad_personalization' IN ('granted', 'denied')
  ),
  CONSTRAINT submissions_user_agent_length_check CHECK (char_length(user_agent) <= 512),
  CONSTRAINT submissions_ip_hmac_check CHECK (ip_hmac ~ '^[0-9a-f]{64}$'),
  CONSTRAINT submissions_antibot_object_check CHECK (jsonb_typeof(antibot) = 'object'),
  -- A purged row carries no raw IP / user agent.
  CONSTRAINT submissions_pii_purge_consistency_check
    CHECK (pii_purged_at IS NULL OR (client_ip IS NULL AND user_agent IS NULL))
);

COMMENT ON TABLE capture.submissions IS 'One row per accepted form submission (immutable except the PII purge columns).';
COMMENT ON COLUMN capture.submissions.client_ip IS 'Raw IP for anti-fraud/CAPI only; nulled after 30 days (retention job, wave 6).';
COMMENT ON COLUMN capture.submissions.user_agent IS 'Raw user agent for CAPI only; nulled after 30 days (retention job, wave 6).';
COMMENT ON COLUMN capture.submissions.ip_hmac IS 'HMAC-SHA256(IP, HASH_PEPPER) hex: kept after the purge for anti-fraud analytics.';
COMMENT ON COLUMN capture.submissions.request_hash IS 'SHA-256 hex of the normalized payload without turnstile_token (idempotency, R7).';

COMMENT ON INDEX capture.submissions_workspace_id_id_key IS
  'Target of the composite foreign key from capture.consents (tenant-safe reference).';
COMMENT ON INDEX capture.submissions_idempotency_key_key IS
  'Second idempotency barrier behind Redis (R7); target of ON CONFLICT (workspace_id, idempotency_key).';
COMMENT ON INDEX capture.submissions_event_id_key IS
  'Pixel x CAPI deduplication: one submission per conversion event_id.';

CREATE INDEX submissions_lead_created_idx ON capture.submissions (lead_id, created_at DESC);
COMMENT ON INDEX capture.submissions_lead_created_idx IS 'Lead timeline: submissions of one lead, newest first.';

CREATE INDEX submissions_pii_purge_idx ON capture.submissions (created_at) WHERE pii_purged_at IS NULL;
COMMENT ON INDEX capture.submissions_pii_purge_idx IS 'Daily PII purge job (wave 6): oldest submissions that still hold raw IP/user agent.';

-- 4.5 capture.consents (append-only) ---------------------------------------

CREATE TABLE capture.consents (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES core.workspaces (id),
  lead_id uuid NOT NULL,
  submission_id uuid NOT NULL,
  purpose text NOT NULL,
  granted boolean NOT NULL,
  policy_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consents_lead_fkey FOREIGN KEY (workspace_id, lead_id) REFERENCES crm.leads (workspace_id, id),
  CONSTRAINT consents_submission_fkey
    FOREIGN KEY (workspace_id, submission_id) REFERENCES capture.submissions (workspace_id, id),
  CONSTRAINT consents_purpose_check
    CHECK (purpose IN ('privacy_policy', 'marketing_communications', 'ad_tracking')),
  CONSTRAINT consents_policy_version_check
    CHECK (policy_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[0-9]+)?$')
);

COMMENT ON TABLE capture.consents IS 'Append-only proof of consent per purpose and policy version (R4, LGPD).';

CREATE INDEX consents_lead_purpose_idx ON capture.consents (lead_id, purpose, created_at DESC);
COMMENT ON INDEX capture.consents_lead_purpose_idx IS 'Current consent of a lead per purpose (latest row wins).';

-- 4.6 crm.lead_activities (append-only) ------------------------------------

CREATE TABLE crm.lead_activities (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES core.workspaces (id),
  lead_id uuid NOT NULL,
  type text NOT NULL,
  actor_type text NOT NULL,
  actor_id uuid,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_activities_lead_fkey FOREIGN KEY (workspace_id, lead_id) REFERENCES crm.leads (workspace_id, id),
  CONSTRAINT lead_activities_type_check CHECK (
    type IN (
      'submission_received', 'stage_changed', 'owner_assigned', 'note_added', 'score_changed',
      'insight_generated', 'conversion_sent', 'anonymized'
    )
  ),
  CONSTRAINT lead_activities_actor_type_check CHECK (actor_type IN ('system', 'user', 'ai')),
  CONSTRAINT lead_activities_data_check
    CHECK (jsonb_typeof(data) = 'object' AND pg_column_size(data) <= 8192)
);

COMMENT ON TABLE crm.lead_activities IS 'Append-only lead timeline. data holds IDs and codes only (no PII), at most 8 KB.';

CREATE INDEX lead_activities_lead_created_idx ON crm.lead_activities (lead_id, created_at DESC);
COMMENT ON INDEX crm.lead_activities_lead_created_idx IS 'Lead timeline, newest first.';

-- 4.7 tracking.outbox_events ------------------------------------------------

CREATE TABLE tracking.outbox_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES core.workspaces (id),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts smallint NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  CONSTRAINT outbox_events_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT outbox_events_aggregate_type_check CHECK (aggregate_type IN ('lead')),
  CONSTRAINT outbox_events_event_type_check CHECK (event_type IN ('lead.captured', 'lead.stage_changed')),
  CONSTRAINT outbox_events_payload_object_check CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT outbox_events_status_check CHECK (status IN ('pending', 'processing', 'done', 'dead')),
  CONSTRAINT outbox_events_attempts_check CHECK (attempts >= 0)
);

COMMENT ON TABLE tracking.outbox_events IS 'Transactional outbox (ADR-0004). payload carries IDs and metadata only, never PII.';

COMMENT ON INDEX tracking.outbox_events_workspace_id_id_key IS
  'Target of the composite foreign key from tracking.deliveries (tenant-safe reference).';

CREATE INDEX outbox_events_sweeper_idx
  ON tracking.outbox_events (status, next_attempt_at)
  WHERE status IN ('pending', 'processing');
COMMENT ON INDEX tracking.outbox_events_sweeper_idx IS 'Outbox sweeper: events still to be dispatched, ordered by next attempt.';

-- 4.8 tracking.deliveries ---------------------------------------------------

CREATE TABLE tracking.deliveries (
  id uuid PRIMARY KEY,
  outbox_event_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES core.workspaces (id),
  destination text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts smallint NOT NULL DEFAULT 0,
  last_http_status smallint,
  -- Internal error code, never the body of a third-party response.
  last_error_code text,
  -- Provider trace reference (e.g. Meta fbtrace_id).
  external_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deliveries_outbox_event_fkey
    FOREIGN KEY (workspace_id, outbox_event_id) REFERENCES tracking.outbox_events (workspace_id, id),
  CONSTRAINT deliveries_outbox_destination_key UNIQUE (outbox_event_id, destination),
  CONSTRAINT deliveries_destination_check
    CHECK (destination IN ('meta_capi', 'ga4_mp', 'google_ads', 'ai_qualification')),
  CONSTRAINT deliveries_status_check CHECK (
    status IN ('pending', 'sent', 'skipped_no_consent', 'skipped_disabled', 'failed', 'dead')
  ),
  CONSTRAINT deliveries_attempts_check CHECK (attempts >= 0),
  CONSTRAINT deliveries_last_http_status_check CHECK (last_http_status BETWEEN 100 AND 599),
  CONSTRAINT deliveries_last_error_code_length_check CHECK (char_length(last_error_code) <= 100),
  CONSTRAINT deliveries_external_ref_length_check CHECK (char_length(external_ref) <= 200)
);

COMMENT ON TABLE tracking.deliveries IS 'One delivery per outbox event and destination (idempotent fan-out).';
COMMENT ON INDEX tracking.deliveries_outbox_destination_key IS
  'Idempotency per destination: reprocessing an event never creates a second delivery.';

-- 4.9 core.audit_log (append-only) -----------------------------------------

CREATE TABLE core.audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES core.workspaces (id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL,
  actor_id uuid,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid,
  result text NOT NULL,
  correlation_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT audit_log_actor_type_check CHECK (actor_type IN ('system', 'user', 'qstash', 'ai')),
  CONSTRAINT audit_log_action_length_check CHECK (char_length(action) BETWEEN 1 AND 100),
  CONSTRAINT audit_log_resource_type_length_check CHECK (char_length(resource_type) BETWEEN 1 AND 50),
  CONSTRAINT audit_log_result_check CHECK (result IN ('success', 'denied', 'error')),
  CONSTRAINT audit_log_metadata_check
    CHECK (jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 8192)
);

COMMENT ON TABLE core.audit_log IS 'Append-only audit trail: who did what to which resource, with the correlation id. No PII in metadata.';

CREATE INDEX audit_log_workspace_occurred_idx ON core.audit_log (workspace_id, occurred_at DESC);
COMMENT ON INDEX core.audit_log_workspace_occurred_idx IS 'Audit browsing and retention scans: newest entries of a workspace.';

-- ---------------------------------------------------------------------------
-- 5. Triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER workspaces_set_updated_at
  BEFORE UPDATE ON core.workspaces
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER forms_set_updated_at
  BEFORE UPDATE ON core.forms
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER leads_set_updated_at
  BEFORE UPDATE ON crm.leads
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE TRIGGER deliveries_set_updated_at
  BEFORE UPDATE ON tracking.deliveries
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TRIGGER consents_append_only
  BEFORE UPDATE OR DELETE ON capture.consents
  FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER consents_no_truncate
  BEFORE TRUNCATE ON capture.consents
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_mutation();

CREATE TRIGGER lead_activities_append_only
  BEFORE UPDATE OR DELETE ON crm.lead_activities
  FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER lead_activities_no_truncate
  BEFORE TRUNCATE ON crm.lead_activities
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_mutation();

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON core.audit_log
  FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON core.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_mutation();

-- ---------------------------------------------------------------------------
-- 6. Row-Level Security: ENABLE + FORCE everywhere (owner included), deny by default.
--    Policies target lp_api only; without app.workspace_id no row is visible.
-- ---------------------------------------------------------------------------

ALTER TABLE core.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.workspaces FORCE ROW LEVEL SECURITY;
ALTER TABLE core.forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.forms FORCE ROW LEVEL SECURITY;
ALTER TABLE core.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.audit_log FORCE ROW LEVEL SECURITY;
ALTER TABLE crm.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.leads FORCE ROW LEVEL SECURITY;
ALTER TABLE crm.lead_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.lead_activities FORCE ROW LEVEL SECURITY;
ALTER TABLE capture.submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture.submissions FORCE ROW LEVEL SECURITY;
ALTER TABLE capture.consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture.consents FORCE ROW LEVEL SECURITY;
ALTER TABLE tracking.outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracking.outbox_events FORCE ROW LEVEL SECURITY;
ALTER TABLE tracking.deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracking.deliveries FORCE ROW LEVEL SECURITY;

-- core.workspaces: the row of the current workspace (read-only for the runtime).
CREATE POLICY workspaces_select ON core.workspaces FOR SELECT TO lp_api
  USING (id = (SELECT core.current_workspace_id()));

-- core.forms: public routing by form_key, so no workspace filter; only active forms are visible.
CREATE POLICY forms_select_active ON core.forms FOR SELECT TO lp_api
  USING (status = 'active');

-- Workspace-scoped tables: one policy per command so a future grant never widens access by accident.
CREATE POLICY leads_select ON crm.leads FOR SELECT TO lp_api
  USING (workspace_id = (SELECT core.current_workspace_id()));
CREATE POLICY leads_insert ON crm.leads FOR INSERT TO lp_api
  WITH CHECK (workspace_id = (SELECT core.current_workspace_id()));
CREATE POLICY leads_update ON crm.leads FOR UPDATE TO lp_api
  USING (workspace_id = (SELECT core.current_workspace_id()))
  WITH CHECK (workspace_id = (SELECT core.current_workspace_id()));

CREATE POLICY submissions_select ON capture.submissions FOR SELECT TO lp_api
  USING (workspace_id = (SELECT core.current_workspace_id()));
CREATE POLICY submissions_insert ON capture.submissions FOR INSERT TO lp_api
  WITH CHECK (workspace_id = (SELECT core.current_workspace_id()));
CREATE POLICY submissions_update ON capture.submissions FOR UPDATE TO lp_api
  USING (workspace_id = (SELECT core.current_workspace_id()))
  WITH CHECK (workspace_id = (SELECT core.current_workspace_id()));

CREATE POLICY consents_select ON capture.consents FOR SELECT TO lp_api
  USING (workspace_id = (SELECT core.current_workspace_id()));
CREATE POLICY consents_insert ON capture.consents FOR INSERT TO lp_api
  WITH CHECK (workspace_id = (SELECT core.current_workspace_id()));

CREATE POLICY lead_activities_select ON crm.lead_activities FOR SELECT TO lp_api
  USING (workspace_id = (SELECT core.current_workspace_id()));
CREATE POLICY lead_activities_insert ON crm.lead_activities FOR INSERT TO lp_api
  WITH CHECK (workspace_id = (SELECT core.current_workspace_id()));

CREATE POLICY audit_log_select ON core.audit_log FOR SELECT TO lp_api
  USING (workspace_id = (SELECT core.current_workspace_id()));
CREATE POLICY audit_log_insert ON core.audit_log FOR INSERT TO lp_api
  WITH CHECK (workspace_id = (SELECT core.current_workspace_id()));

CREATE POLICY outbox_events_select ON tracking.outbox_events FOR SELECT TO lp_api
  USING (workspace_id = (SELECT core.current_workspace_id()));
CREATE POLICY outbox_events_insert ON tracking.outbox_events FOR INSERT TO lp_api
  WITH CHECK (workspace_id = (SELECT core.current_workspace_id()));
CREATE POLICY outbox_events_update ON tracking.outbox_events FOR UPDATE TO lp_api
  USING (workspace_id = (SELECT core.current_workspace_id()))
  WITH CHECK (workspace_id = (SELECT core.current_workspace_id()));

CREATE POLICY deliveries_select ON tracking.deliveries FOR SELECT TO lp_api
  USING (workspace_id = (SELECT core.current_workspace_id()));
CREATE POLICY deliveries_insert ON tracking.deliveries FOR INSERT TO lp_api
  WITH CHECK (workspace_id = (SELECT core.current_workspace_id()));
CREATE POLICY deliveries_update ON tracking.deliveries FOR UPDATE TO lp_api
  USING (workspace_id = (SELECT core.current_workspace_id()))
  WITH CHECK (workspace_id = (SELECT core.current_workspace_id()));

-- ---------------------------------------------------------------------------
-- 7. Grants: explicit allow-list for lp_api. No DELETE, TRUNCATE, REFERENCES, TRIGGER or DDL anywhere.
--    Bulk purge and anonymization run as SECURITY DEFINER functions (wave 6), not through the runtime.
-- ---------------------------------------------------------------------------

REVOKE ALL ON ALL TABLES IN SCHEMA core, crm, capture, tracking FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA core, crm, capture, tracking FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA core, crm, capture, tracking FROM PUBLIC, anon, authenticated, service_role;

GRANT USAGE ON SCHEMA core, crm, capture, tracking TO lp_api;

GRANT SELECT ON core.workspaces TO lp_api;
GRANT SELECT ON core.forms TO lp_api;
GRANT SELECT, INSERT ON core.audit_log TO lp_api;

GRANT SELECT, INSERT, UPDATE ON crm.leads TO lp_api;
GRANT SELECT, INSERT ON crm.lead_activities TO lp_api;

GRANT SELECT, INSERT ON capture.submissions TO lp_api;
GRANT UPDATE (client_ip, user_agent, pii_purged_at) ON capture.submissions TO lp_api;
GRANT SELECT, INSERT ON capture.consents TO lp_api;

GRANT SELECT, INSERT, UPDATE ON tracking.outbox_events TO lp_api;
GRANT SELECT, INSERT, UPDATE ON tracking.deliveries TO lp_api;
