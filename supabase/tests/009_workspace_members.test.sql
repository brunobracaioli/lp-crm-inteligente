-- Wave 9b: core.workspace_members (threat model crm-staff-auth ST-38, C8, C16, C42).
-- Posture (PK, RLS ENABLE + FORCE, grants), constraints, and the two-branch RLS policy: the caller's own ACTIVE
-- memberships through app.staff_user_id, and the members of the current workspace through app.workspace_id.
-- Mirrored by the vitest suite apps/api/test/integration/staff-membership.test.ts (runs against any local Postgres).
-- Fixtures are inserted as the migration owner (BYPASSRLS); every access assertion runs as lp_api.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(30);

-- Fixtures: workspaces A and B. u1: owner of A + inactive in B. u2: sales in A. u3: inactive viewer in A. u4: admin of B.
INSERT INTO core.workspaces (id, slug, name) VALUES
  ('0193a900-0000-7000-8000-00000000000a', 'test-mem-a', 'Members A'),
  ('0193a900-0000-7000-8000-00000000000b', 'test-mem-b', 'Members B');

INSERT INTO core.workspace_members (workspace_id, user_id, display_name, role, active) VALUES
  ('0193a900-0000-7000-8000-00000000000a', '0193a900-0000-7000-8000-0000000000a1', 'Ana Owner', 'owner', true),
  ('0193a900-0000-7000-8000-00000000000a', '0193a900-0000-7000-8000-0000000000a2', 'Bia Sales', 'sales', true),
  ('0193a900-0000-7000-8000-00000000000a', '0193a900-0000-7000-8000-0000000000a3', 'Caio Viewer', 'viewer', false),
  ('0193a900-0000-7000-8000-00000000000b', '0193a900-0000-7000-8000-0000000000a4', 'Dani Admin', 'admin', true),
  ('0193a900-0000-7000-8000-00000000000b', '0193a900-0000-7000-8000-0000000000a1', 'Ana Owner', 'owner', false);

-- ST-38: posture ------------------------------------------------------------------------------------------------

SELECT has_table('core', 'workspace_members', 'core.workspace_members exists');
SELECT col_is_pk('core', 'workspace_members', ARRAY['workspace_id', 'user_id'], 'primary key is (workspace_id, user_id)');
SELECT col_not_null('core', 'workspace_members', 'display_name', 'display_name is NOT NULL');
SELECT fk_ok('core', 'workspace_members', 'workspace_id', 'core', 'workspaces', 'id', 'workspace_id references core.workspaces');
SELECT is(
  (SELECT c.relrowsecurity AND c.relforcerowsecurity FROM pg_catalog.pg_class c WHERE c.oid = 'core.workspace_members'::regclass),
  true,
  'ST-38: row level security is enabled and forced'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles r
    WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
      AND (pg_catalog.has_table_privilege(r.oid, 'core.workspace_members', 'SELECT')
        OR pg_catalog.has_table_privilege(r.oid, 'core.workspace_members', 'INSERT')
        OR pg_catalog.has_table_privilege(r.oid, 'core.workspace_members', 'UPDATE')
        OR pg_catalog.has_table_privilege(r.oid, 'core.workspace_members', 'DELETE'))),
  'ST-38: anon, authenticated and service_role have no privilege on the table'
);
SELECT ok(
  pg_catalog.has_table_privilege('lp_api', 'core.workspace_members', 'SELECT')
    AND NOT pg_catalog.has_table_privilege('lp_api', 'core.workspace_members', 'INSERT')
    AND NOT pg_catalog.has_table_privilege('lp_api', 'core.workspace_members', 'UPDATE')
    AND NOT pg_catalog.has_table_privilege('lp_api', 'core.workspace_members', 'DELETE')
    AND NOT pg_catalog.has_table_privilege('lp_api', 'core.workspace_members', 'TRUNCATE')
    AND NOT pg_catalog.has_table_privilege('lp_api', 'core.workspace_members', 'REFERENCES')
    AND NOT pg_catalog.has_table_privilege('lp_api', 'core.workspace_members', 'TRIGGER'),
  'ST-38: lp_api has SELECT and nothing else'
);
SELECT ok(
  pg_catalog.has_function_privilege('lp_api', 'core.current_staff_user_id()', 'EXECUTE')
    AND NOT pg_catalog.has_function_privilege('anon', 'core.current_staff_user_id()', 'EXECUTE')
    AND NOT pg_catalog.has_function_privilege('authenticated', 'core.current_staff_user_id()', 'EXECUTE'),
  'core.current_staff_user_id() is executable by lp_api only'
);
SELECT is(
  (SELECT count(*) FROM pg_catalog.pg_policies WHERE schemaname = 'core' AND tablename = 'workspace_members'),
  1::bigint,
  'a single SELECT policy guards the table'
);

-- Constraints ---------------------------------------------------------------------------------------------------

SELECT throws_ok(
  $$ INSERT INTO core.workspace_members (workspace_id, user_id, display_name, role)
     VALUES ('0193a900-0000-7000-8000-00000000000a', '0193a900-0000-7000-8000-0000000000e1', 'Eve', 'superuser') $$,
  '23514', NULL, 'role outside owner/admin/sales/viewer is rejected'
);
SELECT throws_ok(
  $$ INSERT INTO core.workspace_members (workspace_id, user_id, display_name, role)
     VALUES ('0193a900-0000-7000-8000-00000000000a', '0193a900-0000-7000-8000-0000000000e2', '', 'sales') $$,
  '23514', NULL, 'an empty display_name is rejected'
);
SELECT throws_ok(
  $$ INSERT INTO core.workspace_members (workspace_id, user_id, display_name, role)
     VALUES ('0193a900-0000-7000-8000-00000000000a', '0193a900-0000-7000-8000-0000000000e3', repeat('x', 81), 'sales') $$,
  '23514', NULL, 'a display_name longer than 80 characters is rejected'
);
SELECT throws_ok(
  $$ INSERT INTO core.workspace_members (workspace_id, user_id, display_name, role)
     VALUES ('0193a900-0000-7000-8000-00000000000a', '0193a900-0000-7000-8000-0000000000e4', 'Bob' || chr(8238) || 'evil', 'sales') $$,
  '23514', NULL, 'a display_name with a bidi override is rejected'
);
SELECT throws_ok(
  $$ INSERT INTO core.workspace_members (workspace_id, user_id, display_name, role)
     VALUES ('0193a900-0000-7000-8000-00000000000a', '0193a900-0000-7000-8000-0000000000e5', 'Line' || chr(10) || 'break', 'sales') $$,
  '23514', NULL, 'a display_name with a control character is rejected'
);
SELECT throws_ok(
  $$ INSERT INTO core.workspace_members (workspace_id, user_id, display_name, role)
     VALUES ('0193a900-0000-7000-8000-00000000000a', '0193a900-0000-7000-8000-0000000000e6', ' padded ', 'sales') $$,
  '23514', NULL, 'a display_name with surrounding whitespace is rejected'
);
SELECT throws_ok(
  $$ INSERT INTO core.workspace_members (workspace_id, user_id, display_name, role)
     VALUES ('0193a900-0000-7000-8000-0000000000ff', '0193a900-0000-7000-8000-0000000000e7', 'Ghost', 'sales') $$,
  '23503', NULL, 'a membership of a nonexistent workspace is rejected'
);
SELECT throws_ok(
  $$ INSERT INTO core.workspace_members (workspace_id, user_id, display_name, role)
     VALUES ('0193a900-0000-7000-8000-00000000000a', '0193a900-0000-7000-8000-0000000000a1', 'Again', 'admin') $$,
  '23505', NULL, 'the same user cannot be a member twice of one workspace'
);

-- RLS as lp_api -------------------------------------------------------------------------------------------------

-- pgTAP lives in `extensions`; the test role needs to reach it. Both grants are rolled back with the test.
GRANT lp_api TO postgres WITH SET TRUE;
GRANT USAGE ON SCHEMA extensions TO lp_api;
SET LOCAL ROLE lp_api;

SELECT is((SELECT count(*) FROM core.workspace_members), 0::bigint, 'deny by default: no setting, no rows');

SELECT pg_catalog.set_config('app.staff_user_id', '', true);
SELECT pg_catalog.set_config('app.workspace_id', '', true);
SELECT lives_ok($$ SELECT 1 FROM core.workspace_members $$, 'empty settings (reused pooled connection) do not raise');
SELECT is((SELECT count(*) FROM core.workspace_members), 0::bigint, 'empty settings match no row');

-- Membership lookup: user u1 is owner of A and INACTIVE in B -> only the active row is reachable.
SELECT pg_catalog.set_config('app.staff_user_id', '0193a900-0000-7000-8000-0000000000a1', true);
SELECT results_eq(
  $$ SELECT workspace_id, role FROM core.workspace_members $$,
  $$ VALUES ('0193a900-0000-7000-8000-00000000000a'::uuid, 'owner'::text) $$,
  'lookup by user: only the ACTIVE membership of the caller is visible'
);

-- A user with only an inactive membership resolves to nothing.
SELECT pg_catalog.set_config('app.staff_user_id', '0193a900-0000-7000-8000-0000000000a3', true);
SELECT is((SELECT count(*) FROM core.workspace_members), 0::bigint, 'lookup by user: an inactive member sees no membership');

-- Cannot read somebody else's membership by filtering: the setting is the only key.
SELECT pg_catalog.set_config('app.staff_user_id', '0193a900-0000-7000-8000-0000000000a2', true);
SELECT is(
  (SELECT count(*) FROM core.workspace_members WHERE user_id = '0193a900-0000-7000-8000-0000000000a4'),
  0::bigint,
  'lookup by user: the membership of another user is invisible even by primary key'
);
SELECT pg_catalog.set_config('app.staff_user_id', '', true);

-- Workspace branch: members of A (active and inactive), none of B.
SELECT pg_catalog.set_config('app.workspace_id', '0193a900-0000-7000-8000-00000000000a', true);
SELECT results_eq(
  $$ SELECT user_id FROM core.workspace_members ORDER BY user_id $$,
  $$ VALUES ('0193a900-0000-7000-8000-0000000000a1'::uuid), ('0193a900-0000-7000-8000-0000000000a2'::uuid), ('0193a900-0000-7000-8000-0000000000a3'::uuid) $$,
  'workspace A sees its three members (active and inactive)'
);
SELECT is(
  (SELECT count(*) FROM core.workspace_members WHERE workspace_id = '0193a900-0000-7000-8000-00000000000b'),
  0::bigint,
  'cross-tenant: workspace A cannot see any member of workspace B'
);
SELECT pg_catalog.set_config('app.workspace_id', '0193a900-0000-7000-8000-00000000000b', true);
SELECT results_eq(
  $$ SELECT user_id FROM core.workspace_members ORDER BY user_id $$,
  $$ VALUES ('0193a900-0000-7000-8000-0000000000a1'::uuid), ('0193a900-0000-7000-8000-0000000000a4'::uuid) $$,
  'workspace B sees only its own two members'
);
SELECT pg_catalog.set_config('app.workspace_id', '', true);

-- Read-only runtime ---------------------------------------------------------------------------------------------

SELECT throws_ok(
  $$ INSERT INTO core.workspace_members (workspace_id, user_id, display_name, role)
     VALUES ('0193a900-0000-7000-8000-00000000000a', '0193a900-0000-7000-8000-0000000000f1', 'Mallory', 'owner') $$,
  '42501', NULL, 'lp_api cannot INSERT a member (no role escalation through the API)'
);
SELECT throws_ok($$ UPDATE core.workspace_members SET role = 'owner' $$, '42501', NULL, 'lp_api cannot UPDATE a role');
SELECT throws_ok($$ DELETE FROM core.workspace_members $$, '42501', NULL, 'lp_api cannot DELETE a member');
RESET ROLE;

-- The Data API roles are denied outright ---------------------------------------------------------------------------

SET LOCAL ROLE authenticated;
SELECT throws_ok($$ SELECT 1 FROM core.workspace_members $$, '42501', NULL, 'ST-38: authenticated denied on core.workspace_members');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
