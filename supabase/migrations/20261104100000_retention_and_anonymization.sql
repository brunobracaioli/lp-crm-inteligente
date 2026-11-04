-- Wave 6b - retention, purge and LGPD anonymization (docs/specs/database.md sections 4 and 6; ADR-0004).
--
-- Bulk purge and anonymization never run through the runtime role: they are SECURITY DEFINER functions with
-- an empty search_path, scheduled by pg_cron, plus one function for the API (crm.anonymize_lead, lp_api only).
--
-- Conventions (same as the core schema migration):
--   * No dynamic SQL (Semgrep rule no-dynamic-sql-in-migrations); every object is fully qualified.
--   * The definer functions are owned by the migration role. Every table has FORCE ROW LEVEL SECURITY and its
--     policies target lp_api only, so the owner sees rows only through SUPERUSER / BYPASSRLS (Supabase `postgres`
--     has BYPASSRLS). Section 0 fails the migration loudly when that does not hold.
--   * Migrations are immutable: this file only adds objects and replaces two append-only triggers.

-- ---------------------------------------------------------------------------
-- 0. Preconditions. Neither check is optional: a missing pg_cron or an owner that cannot bypass RLS must fail
--    the deploy instead of silently shipping retention that never runs (or runs against zero rows).
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = CURRENT_USER AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION
      'migration role % must be SUPERUSER or BYPASSRLS: the SECURITY DEFINER retention functions read tables '
      'with forced RLS whose policies target lp_api only', CURRENT_USER;
  END IF;
END
$$;

-- Supabase installs pg_cron in pg_catalog (https://supabase.com/docs/guides/cron/install) and `supabase start`
-- ships it. The throwaway Postgres used without Docker has no pg_cron: scripts/local-db/pg_cron_stub provides
-- an extension of the same name through extension_control_path, so this statement is the same everywhere.
-- If the extension is unavailable this statement raises: there is deliberately no conditional fallback.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

-- ---------------------------------------------------------------------------
-- 1. Indexes for the retention scans (small tables today; keeps the jobs index-driven as data grows).
-- ---------------------------------------------------------------------------

CREATE INDEX audit_log_occurred_idx ON core.audit_log (occurred_at);
COMMENT ON INDEX core.audit_log_occurred_idx IS 'Monthly audit retention job: oldest entries across workspaces.';

CREATE INDEX outbox_events_retention_idx ON tracking.outbox_events (processed_at) WHERE status = 'done';
COMMENT ON INDEX tracking.outbox_events_retention_idx IS 'Daily outbox retention job: completed events by completion time.';

CREATE INDEX leads_retention_idx ON crm.leads (last_submitted_at) WHERE anonymized_at IS NULL AND stage <> 'won';
COMMENT ON INDEX crm.leads_retention_idx IS 'Daily inactivity job: active, non-won leads by last submission (24-month rule, Q5).';

-- ---------------------------------------------------------------------------
-- 2. Append-only guards with ONE narrow exception each. The old combined triggers (UPDATE OR DELETE) are replaced
--    by one trigger per operation. The exception requires a transaction-local flag that only the definer
--    functions below set, and is bounded by the data itself, so even a forged flag by a privileged role cannot
--    rewrite history: lp_api has no UPDATE / DELETE privilege on these tables in the first place.
-- ---------------------------------------------------------------------------

-- core.audit_log: DELETE allowed only for rows past the 12-month retention, inside the purge function.
CREATE FUNCTION core.guard_audit_log_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF pg_catalog.current_setting('app.retention_purge', true) = 'on'
     AND OLD.occurred_at < pg_catalog.now() - INTERVAL '12 months' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'append-only table: % on %.% is not allowed', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

COMMENT ON FUNCTION core.guard_audit_log_delete() IS
  'BEFORE DELETE trigger of core.audit_log: only rows older than 12 months, only while core.purge_audit_log runs.';

DROP TRIGGER audit_log_append_only ON core.audit_log;
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON core.audit_log
  FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();
CREATE TRIGGER audit_log_retention_delete
  BEFORE DELETE ON core.audit_log
  FOR EACH ROW EXECUTE FUNCTION core.guard_audit_log_delete();

-- crm.lead_activities: UPDATE allowed only to rewrite `data` (never type, actor, lead or timestamps), and only
-- while crm.anonymize_lead_unchecked scrubs the lead (LGPD erasure; threat model C35 / G4). DELETE stays blocked.
CREATE FUNCTION crm.guard_lead_activity_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF pg_catalog.current_setting('app.lead_anonymization', true) = 'on'
     AND (pg_catalog.to_jsonb(NEW) - 'data') = (pg_catalog.to_jsonb(OLD) - 'data') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'append-only table: % on %.% is not allowed', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

COMMENT ON FUNCTION crm.guard_lead_activity_update() IS
  'BEFORE UPDATE trigger of crm.lead_activities: only `data` may change, only while a lead is being anonymized.';

DROP TRIGGER lead_activities_append_only ON crm.lead_activities;
CREATE TRIGGER lead_activities_scrub_only
  BEFORE UPDATE ON crm.lead_activities
  FOR EACH ROW EXECUTE FUNCTION crm.guard_lead_activity_update();
CREATE TRIGGER lead_activities_no_delete
  BEFORE DELETE ON crm.lead_activities
  FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();

-- ---------------------------------------------------------------------------
-- 3. Scrub helpers (pure functions, no table access).
-- ---------------------------------------------------------------------------

-- Attribution snapshot (first_touch / last_touch, snake_case keys): keep campaign metadata, drop identifiers.
-- Kept: utm_*. Query string and fragment are stripped from the two URLs. Dropped: click IDs, fbp, fbc, ga_client_id.
CREATE FUNCTION crm.scrub_attribution_snapshot(p_touch jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT COALESCE(
    pg_catalog.jsonb_object_agg(
      e.key,
      CASE
        WHEN e.key IN ('landing_page_url', 'referrer_url') AND pg_catalog.jsonb_typeof(e.value) = 'string'
          THEN pg_catalog.to_jsonb(pg_catalog.regexp_replace(e.value #>> '{}', '[?#].*$', ''))
        ELSE e.value
      END
    ),
    '{}'::pg_catalog.jsonb
  )
  FROM pg_catalog.jsonb_each(p_touch) AS e (key, value)
  WHERE e.key IN (
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
    'landing_page_url', 'referrer_url'
  )
$$;

COMMENT ON FUNCTION crm.scrub_attribution_snapshot(jsonb) IS
  'Anonymization: keeps utm_* and the URLs without query string; drops click IDs, fbp, fbc and ga_client_id.';

-- Activity payload: note bodies are replaced; every other payload keeps only an allow-list of ID / code / number
-- keys (database 3.6: data holds IDs and codes), so a key added later never leaks free text through erasure.
CREATE FUNCTION crm.scrub_activity_data(p_type text, p_data jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_type = 'note_added' THEN '{"body": "[anonymized]"}'::pg_catalog.jsonb
    ELSE COALESCE(
      (
        SELECT pg_catalog.jsonb_object_agg(e.key, e.value)
        FROM pg_catalog.jsonb_each(p_data) AS e (key, value)
        WHERE e.key IN (
          'submission_id', 'score', 'score_band', 'submissions_count', 'from_band', 'to_band',
          'from', 'to', 'from_stage', 'to_stage', 'lost_reason', 'previous_owner_id', 'owner_id',
          'from_owner_user_id', 'to_owner_user_id', 'from_score', 'to_score', 'destination', 'insight_id'
        )
          AND pg_catalog.jsonb_typeof(e.value) IN ('string', 'number', 'boolean', 'null')
      ),
      '{}'::pg_catalog.jsonb
    )
  END
$$;

COMMENT ON FUNCTION crm.scrub_activity_data(text, jsonb) IS
  'Anonymization: note_added body -> placeholder; other activities keep only allow-listed ID / code / number keys.';

-- ---------------------------------------------------------------------------
-- 4. Anonymization (database 6). The unchecked function takes the workspace explicitly (used by the 24-month job
--    across workspaces); the public one derives it from the transaction scope. Both are definer functions.
-- ---------------------------------------------------------------------------

CREATE FUNCTION crm.anonymize_lead_unchecked(
  p_workspace_id uuid,
  p_lead_id uuid,
  p_actor_type text,
  p_actor_id uuid,
  p_correlation_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.now();
  v_locked_id uuid;
BEGIN
  IF p_workspace_id IS NULL OR p_lead_id IS NULL OR p_actor_type IS NULL OR p_correlation_id IS NULL THEN
    RAISE EXCEPTION 'anonymize_lead: workspace, lead, actor type and correlation id are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Lock first: a concurrent call blocks here, then re-checks anonymized_at and returns false.
  SELECT l.id INTO v_locked_id
  FROM crm.leads AS l
  WHERE l.workspace_id = p_workspace_id AND l.id = p_lead_id AND l.anonymized_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM pg_catalog.set_config('app.lead_anonymization', 'on', true);

  -- Irreversible placeholders; each satisfies the table CHECKs. IDs, stage, score and dates are kept.
  -- job_title and the free-text "other" area also identify the person, so they are cleared too; the opt-in flag
  -- is switched off so no marketing export can pick the lead up.
  UPDATE crm.leads AS l
  SET first_name = 'Anonymized',
      last_name = 'Lead',
      email = 'anon+' || p_lead_id::text || '@anonymized.invalid',
      whatsapp_e164 = '+10000000000',
      company_name = 'Anonymized',
      company_website = NULL,
      job_title = NULL,
      area_of_expertise_other = CASE WHEN l.area_of_expertise = 'other' THEN 'anonymized' END,
      marketing_opt_in = false,
      first_touch = crm.scrub_attribution_snapshot(l.first_touch),
      last_touch = crm.scrub_attribution_snapshot(l.last_touch),
      anonymized_at = v_now,
      version = l.version + 1
  WHERE l.workspace_id = p_workspace_id AND l.id = p_lead_id;

  -- Submissions: free text, form snapshot, identifiers and anything derived from the original payload.
  -- request_hash (unkeyed SHA-256 of the payload) and ip_hmac would let someone confirm a guessed e-mail or IP,
  -- so they become all-zero hex. Consents are kept untouched as proof (database 6).
  UPDATE capture.submissions AS s
  SET fields = '{}'::pg_catalog.jsonb,
      message = NULL,
      gclid = NULL,
      gbraid = NULL,
      wbraid = NULL,
      fbclid = NULL,
      ttclid = NULL,
      msclkid = NULL,
      fbp = NULL,
      fbc = NULL,
      ga_client_id = NULL,
      landing_page_url = pg_catalog.regexp_replace(s.landing_page_url, '[?#].*$', ''),
      referrer_url = pg_catalog.regexp_replace(s.referrer_url, '[?#].*$', ''),
      client_ip = NULL,
      user_agent = NULL,
      pii_purged_at = COALESCE(s.pii_purged_at, v_now),
      ip_hmac = pg_catalog.repeat('0', 64),
      request_hash = pg_catalog.repeat('0', 64),
      antibot = s.antibot - 'ephemeral_id'
  WHERE s.workspace_id = p_workspace_id AND s.lead_id = p_lead_id;

  -- Timeline: note bodies and any PII in payloads (append-only for everyone else; see section 2).
  UPDATE crm.lead_activities AS a
  SET data = crm.scrub_activity_data(a.type, a.data)
  WHERE a.workspace_id = p_workspace_id AND a.lead_id = p_lead_id;

  INSERT INTO crm.lead_activities (id, workspace_id, lead_id, type, actor_type, actor_id, data, created_at)
  VALUES (
    pg_catalog.gen_random_uuid(), p_workspace_id, p_lead_id, 'anonymized', p_actor_type, p_actor_id,
    '{}'::pg_catalog.jsonb, v_now
  );

  PERFORM pg_catalog.set_config('app.lead_anonymization', 'off', true);

  -- IDs only (no PII): lets an operator join the database log with the API audit row.
  RAISE LOG 'lead_anonymized workspace_id=% lead_id=% correlation_id=%', p_workspace_id, p_lead_id, p_correlation_id;
  RETURN true;
END
$$;

COMMENT ON FUNCTION crm.anonymize_lead_unchecked(uuid, uuid, text, uuid, uuid) IS
  'INTERNAL (not executable by lp_api): LGPD anonymization of one lead in an explicit workspace. Used by crm.anonymize_lead and the inactivity job.';

-- Public entry point of the API. Frozen signature (wave 9b codes against it).
CREATE FUNCTION crm.anonymize_lead(
  p_lead_id uuid,
  p_actor_type text,
  p_actor_id uuid,
  p_correlation_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_workspace_id uuid := core.current_workspace_id();
BEGIN
  -- No workspace in scope: nothing is visible, so nothing is anonymized (same deny-by-default as RLS).
  IF v_workspace_id IS NULL THEN
    RETURN false;
  END IF;
  RETURN crm.anonymize_lead_unchecked(v_workspace_id, p_lead_id, p_actor_type, p_actor_id, p_correlation_id);
END
$$;

COMMENT ON FUNCTION crm.anonymize_lead(uuid, text, uuid, uuid) IS
  'LGPD anonymization of a lead of the CURRENT workspace (app.workspace_id). true = anonymized now; false = not visible in the workspace or already anonymized. Writes no audit row: the API audits (including denials).';

-- ---------------------------------------------------------------------------
-- 5. Purge jobs. Each processes at most p_batch_size x p_max_batches rows per run (bounded locks and runtime);
--    a backlog continues on the next run. All are idempotent and return the number of rows handled.
-- ---------------------------------------------------------------------------

-- 5.1 Raw IP and user agent of submissions: 30 days.
CREATE FUNCTION capture.purge_submission_pii(p_batch_size integer DEFAULT 1000, p_max_batches integer DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_total integer := 0;
  v_batch integer;
BEGIN
  IF p_batch_size NOT BETWEEN 1 AND 10000 OR p_max_batches NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'purge_submission_pii: batch size 1..10000 and max batches 1..1000 required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  FOR v_round IN 1..p_max_batches LOOP
    WITH due AS (
      SELECT s.id
      FROM capture.submissions AS s
      WHERE s.pii_purged_at IS NULL AND s.created_at < pg_catalog.now() - INTERVAL '30 days'
      ORDER BY s.created_at, s.id
      LIMIT p_batch_size
      FOR UPDATE SKIP LOCKED
    )
    UPDATE capture.submissions AS s
    SET client_ip = NULL, user_agent = NULL, pii_purged_at = pg_catalog.now()
    FROM due
    WHERE s.id = due.id;
    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_total := v_total + v_batch;
    EXIT WHEN v_batch < p_batch_size;
  END LOOP;
  RETURN v_total;
END
$$;

COMMENT ON FUNCTION capture.purge_submission_pii(integer, integer) IS
  'Retention job (cron only): NULLs client_ip / user_agent of submissions older than 30 days and sets pii_purged_at.';

-- 5.2 Completed outbox events and their deliveries: 90 days. Only status = done (every delivery terminal);
--     pending / processing / dead events are never touched (dead ones await manual reprocessing).
CREATE FUNCTION tracking.purge_completed_outbox(p_batch_size integer DEFAULT 1000, p_max_batches integer DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_total integer := 0;
  v_batch integer;
  v_due_ids uuid[];
BEGIN
  IF p_batch_size NOT BETWEEN 1 AND 10000 OR p_max_batches NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'purge_completed_outbox: batch size 1..10000 and max batches 1..1000 required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  FOR v_round IN 1..p_max_batches LOOP
    SELECT pg_catalog.array_agg(due.id) INTO v_due_ids
    FROM (
      SELECT e.id
      FROM tracking.outbox_events AS e
      WHERE e.status = 'done'
        AND e.processed_at < pg_catalog.now() - INTERVAL '90 days'
        AND NOT EXISTS (
          SELECT 1 FROM tracking.deliveries AS d
          WHERE d.outbox_event_id = e.id AND d.status IN ('pending', 'failed')
        )
      ORDER BY e.processed_at, e.id
      LIMIT p_batch_size
      FOR UPDATE SKIP LOCKED
    ) AS due;
    EXIT WHEN v_due_ids IS NULL;

    DELETE FROM tracking.deliveries AS d WHERE d.outbox_event_id = ANY (v_due_ids);
    DELETE FROM tracking.outbox_events AS e WHERE e.id = ANY (v_due_ids);
    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_total := v_total + v_batch;
    EXIT WHEN v_batch < p_batch_size;
  END LOOP;
  RETURN v_total;
END
$$;

COMMENT ON FUNCTION tracking.purge_completed_outbox(integer, integer) IS
  'Retention job (cron only): deletes done outbox events older than 90 days with their deliveries; never pending, processing or dead.';

-- 5.3 Audit log: 12 months.
CREATE FUNCTION core.purge_audit_log(p_batch_size integer DEFAULT 1000, p_max_batches integer DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_total integer := 0;
  v_batch integer;
BEGIN
  IF p_batch_size NOT BETWEEN 1 AND 10000 OR p_max_batches NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'purge_audit_log: batch size 1..10000 and max batches 1..1000 required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM pg_catalog.set_config('app.retention_purge', 'on', true);
  FOR v_round IN 1..p_max_batches LOOP
    DELETE FROM core.audit_log AS a
    WHERE a.id IN (
      SELECT o.id
      FROM core.audit_log AS o
      WHERE o.occurred_at < pg_catalog.now() - INTERVAL '12 months'
      ORDER BY o.occurred_at, o.id
      LIMIT p_batch_size
      FOR UPDATE SKIP LOCKED
    );
    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_total := v_total + v_batch;
    EXIT WHEN v_batch < p_batch_size;
  END LOOP;
  PERFORM pg_catalog.set_config('app.retention_purge', 'off', true);
  RETURN v_total;
END
$$;

COMMENT ON FUNCTION core.purge_audit_log(integer, integer) IS
  'Retention job (cron only): deletes audit entries older than 12 months (the only DELETE path the append-only trigger allows).';

-- 5.4 Leads without activity for 24 months (Q5), stage <> won: anonymize across workspaces.
--     "Activity" = a submission or any timeline entry; the cutoff applies to the latest of them.
CREATE FUNCTION crm.anonymize_inactive_leads(p_batch_size integer DEFAULT 100, p_max_batches integer DEFAULT 10)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_total integer := 0;
  v_batch integer;
  v_lead record;
  v_cutoff timestamptz := pg_catalog.now() - INTERVAL '24 months';
BEGIN
  IF p_batch_size NOT BETWEEN 1 AND 1000 OR p_max_batches NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'anonymize_inactive_leads: batch size 1..1000 and max batches 1..1000 required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  FOR v_round IN 1..p_max_batches LOOP
    v_batch := 0;
    FOR v_lead IN
      SELECT l.workspace_id, l.id
      FROM crm.leads AS l
      WHERE l.anonymized_at IS NULL
        AND l.stage <> 'won'
        AND l.last_submitted_at < v_cutoff
        AND NOT EXISTS (
          SELECT 1 FROM crm.lead_activities AS a
          WHERE a.workspace_id = l.workspace_id AND a.lead_id = l.id AND a.created_at >= v_cutoff
        )
      ORDER BY l.last_submitted_at, l.id
      LIMIT p_batch_size
    LOOP
      IF crm.anonymize_lead_unchecked(v_lead.workspace_id, v_lead.id, 'system', NULL, pg_catalog.gen_random_uuid()) THEN
        v_batch := v_batch + 1;
      END IF;
    END LOOP;
    v_total := v_total + v_batch;
    EXIT WHEN v_batch < p_batch_size;
  END LOOP;
  RETURN v_total;
END
$$;

COMMENT ON FUNCTION crm.anonymize_inactive_leads(integer, integer) IS
  'Retention job (cron only): anonymizes non-won leads with no submission or timeline activity for 24 months, across workspaces.';

-- ---------------------------------------------------------------------------
-- 6. Privileges. The private schemas already deny PUBLIC / anon / authenticated / service_role; functions are
--    revoked explicitly as well (default privileges may grant EXECUTE to them on a hosted project).
--    Only crm.anonymize_lead is executable by lp_api; the purge and internal functions run from cron only.
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION core.guard_audit_log_delete() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION crm.guard_lead_activity_update() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION crm.scrub_attribution_snapshot(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION crm.scrub_activity_data(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION crm.anonymize_lead_unchecked(uuid, uuid, text, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION crm.anonymize_lead(uuid, text, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION capture.purge_submission_pii(integer, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION tracking.purge_completed_outbox(integer, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION core.purge_audit_log(integer, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION crm.anonymize_inactive_leads(integer, integer) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION crm.anonymize_lead(uuid, text, uuid, uuid) TO lp_api;

-- ---------------------------------------------------------------------------
-- 7. Schedules (UTC). cron.schedule(name, ...) replaces a job of the same name, so re-running is safe.
-- ---------------------------------------------------------------------------

SELECT cron.schedule('lp-retention-purge-submission-pii', '15 3 * * *', 'SELECT capture.purge_submission_pii()');
SELECT cron.schedule('lp-retention-purge-completed-outbox', '30 3 * * *', 'SELECT tracking.purge_completed_outbox()');
SELECT cron.schedule('lp-retention-anonymize-inactive-leads', '0 4 * * *', 'SELECT crm.anonymize_inactive_leads()');
SELECT cron.schedule('lp-retention-purge-audit-log', '45 3 1 * *', 'SELECT core.purge_audit_log()');
