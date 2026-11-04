-- Wave 9b - core.workspace_members (docs/specs/database.md section 3.10; threat model crm-staff-auth C8, C16, C42).
--
-- Who may use the CRM, in which workspace and with which role. The API reads it on EVERY staff request
-- (the access token only proves who the caller is; workspace and role come from here, never from claims).
--
-- Membership resolution runs BEFORE any workspace is known, so the runtime needs a way to read "my own
-- memberships" without a broad SELECT. Design (ADR-less, justified here and in database.md section 4):
--   * A second transaction-local setting, app.staff_user_id (the verified `sub`), read by
--     core.current_staff_user_id() - the same mechanism as app.workspace_id, no privilege elevation.
--   * One RLS policy with two branches:
--       (a) rows of the current workspace (app.workspace_id) - used by GET /v1/crm/members and, later, by
--           the "owner must be an active member" checks of the write routes;
--       (b) ACTIVE rows of the current user (app.staff_user_id) - used only by the membership lookup.
--     Without either setting the policy matches nothing (deny by default). Inactive rows of another
--     workspace are never reachable through branch (b).
--   * Rejected alternative: a SECURITY DEFINER lookup function. It would take the user id as an argument just
--     like the setting does (so no extra safety against a compromised API), and it adds an elevated-privilege
--     object that must be audited forever.
--   * lp_api gets SELECT only: members are provisioned out of band (migration/seed/owner console); there is
--     no API route to create users, change roles or (de)activate members, hence no role escalation via API.
--
-- user_id is a logical reference to auth.users.id, deliberately not a foreign key (same decision as
-- crm.leads.owner_user_id): the migrations must apply on a plain Postgres, and a deleted auth user cannot
-- obtain a token anyway. Offboarding = UPDATE ... SET active = false by the owner; effective on the next request.
--
-- No dynamic SQL (Semgrep rule no-dynamic-sql-in-migrations). Migrations are immutable: fix forward.

CREATE FUNCTION core.current_staff_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT NULLIF(pg_catalog.current_setting('app.staff_user_id', true), '')::uuid
$$;

COMMENT ON FUNCTION core.current_staff_user_id() IS
  'Authenticated staff user id from the transaction-local setting app.staff_user_id (the verified token sub); NULL when unset or empty.';

CREATE TABLE core.workspace_members (
  workspace_id uuid NOT NULL,
  -- Logical reference to auth.users.id; deliberately not a foreign key.
  user_id uuid NOT NULL,
  -- Name shown to other staff (lead owner picker, activity timeline). Never an e-mail; no PII beyond a display name.
  display_name text NOT NULL,
  role text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_members_pkey PRIMARY KEY (workspace_id, user_id),
  CONSTRAINT workspace_members_workspace_fkey FOREIGN KEY (workspace_id) REFERENCES core.workspaces (id),
  CONSTRAINT workspace_members_role_check CHECK (role IN ('owner', 'admin', 'sales', 'viewer')),
  CONSTRAINT workspace_members_display_name_length_check CHECK (char_length(display_name) BETWEEN 1 AND 80),
  -- No control characters, zero-width, bidi override/isolate or BOM (Trojan Source in a name shown to colleagues).
  CONSTRAINT workspace_members_display_name_safe_check
    CHECK (display_name !~ '[\u0000-\u001F\u007F-\u009F​-‏ -‮⁠-⁩﻿]'
           AND display_name = pg_catalog.btrim(display_name))
);

COMMENT ON TABLE core.workspace_members IS
  'Staff membership: who may use the CRM of a workspace and with which role. Provisioned out of band; lp_api is read-only.';
COMMENT ON COLUMN core.workspace_members.user_id IS 'Logical reference to auth.users.id (the sub of the access token); not a foreign key.';

CREATE INDEX workspace_members_user_active_idx ON core.workspace_members (user_id) WHERE active;
COMMENT ON INDEX core.workspace_members_user_active_idx IS
  'Membership lookup by the token sub before any workspace is known (every staff request).';

ALTER TABLE core.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.workspace_members FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_members_select ON core.workspace_members FOR SELECT TO lp_api
  USING (
    workspace_id = (SELECT core.current_workspace_id())
    OR (active AND user_id = (SELECT core.current_staff_user_id()))
  );

REVOKE ALL ON TABLE core.workspace_members FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION core.current_staff_user_id() FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON core.workspace_members TO lp_api;
-- RLS policy expressions run with the privileges of the querying role.
GRANT EXECUTE ON FUNCTION core.current_staff_user_id() TO lp_api;
