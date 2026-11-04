-- Local development seed (runs only on `supabase db reset`; never applied to a hosted project).
-- One workspace and the public form used by the LP. No secrets, no personal data.
-- Fixed UUIDs (version 7 layout) so local tests and fixtures can reference them.

INSERT INTO core.workspaces (id, slug, name)
VALUES ('01930000-0000-7000-8000-000000000001', 'default', 'Default workspace')
ON CONFLICT (id) DO NOTHING;

-- Development origins only: the LP dev server (http://localhost:4321) and bare http://localhost.
-- Production origins (https://www.<domain>) are added by the project owner, never by the seed.
INSERT INTO core.forms (
  id, workspace_id, form_key, name, status, allowed_origins, turnstile_action, privacy_policy_version
)
VALUES (
  '01930000-0000-7000-8000-000000000002',
  '01930000-0000-7000-8000-000000000001',
  'frm_lp_principal',
  'LP principal',
  'active',
  ARRAY['http://localhost', 'http://localhost:4321'],
  'lead_submit',
  '2026-11-03'
)
ON CONFLICT (id) DO NOTHING;
