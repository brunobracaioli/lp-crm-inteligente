-- LOCAL TEST STUB. Never applied to a Supabase project: hosted and `supabase start` databases ship the
-- real pg_cron. It reproduces the part of the API the retention migration uses (cron.schedule by name,
-- idempotent on re-run) and the cron.job columns the tests read. Jobs are recorded, never executed.

CREATE SCHEMA cron;

CREATE TABLE cron.job (
  jobid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  schedule text NOT NULL,
  command text NOT NULL,
  nodename text NOT NULL DEFAULT 'localhost',
  nodeport integer NOT NULL DEFAULT 5432,
  database text NOT NULL DEFAULT pg_catalog.current_database(),
  username text NOT NULL DEFAULT CURRENT_USER,
  active boolean NOT NULL DEFAULT true,
  jobname text,
  CONSTRAINT jobname_username_uniq UNIQUE (jobname, username)
);

CREATE FUNCTION cron.schedule(job_name text, schedule text, command text)
RETURNS bigint
LANGUAGE sql
AS $$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command)
  ON CONFLICT (jobname, username)
  DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command, active = true
  RETURNING jobid
$$;

CREATE FUNCTION cron.unschedule(job_name text)
RETURNS boolean
LANGUAGE sql
AS $$
  WITH removed AS (DELETE FROM cron.job WHERE jobname = job_name AND username = CURRENT_USER RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM removed)
$$;
