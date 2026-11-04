import { z } from 'zod';
import type { Sql } from '#/platform/db/client.ts';
import type { FormId, WorkspaceId } from '#/shared/ids.ts';
import type { FormDefinition, FormLookup } from '#/modules/lead-capture/application/ports.ts';

/** Upper bound of origins per form; the CHECK only validates their format. */
const MAX_ALLOWED_ORIGINS = 20;

const formRowSchema = z.strictObject({
  id: z.guid(),
  workspace_id: z.guid(),
  form_key: z.string(),
  allowed_origins: z.array(z.string()).min(1).max(MAX_ALLOWED_ORIGINS),
  turnstile_action: z.string(),
  privacy_policy_version: z.string(),
});

/**
 * Public routing (lead-capture §2, step 5): no workspace is known yet, so the transaction is not
 * scoped. Visibility is decided by the RLS policy `forms_select_active` (`status = 'active'`), which
 * is the only way `lp_api` can read `core.forms`; the explicit predicate repeats it for readers.
 * `allowed_origins` travels as JSON because the client runs with `fetch_types: false`.
 */
export function createPostgresFormLookup(sql: Sql): FormLookup {
  return {
    async findActiveByKey(formKey: string): Promise<FormDefinition | null> {
      const rows = await sql<object[]>`
        SELECT
          id,
          workspace_id,
          form_key,
          pg_catalog.to_jsonb(allowed_origins) AS allowed_origins,
          turnstile_action,
          privacy_policy_version
        FROM core.forms
        WHERE form_key = ${formKey} AND status = 'active'
      `;
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      const form = formRowSchema.parse(row);
      return {
        id: form.id as FormId,
        workspaceId: form.workspace_id as WorkspaceId,
        formKey: form.form_key,
        allowedOrigins: form.allowed_origins,
        turnstileAction: form.turnstile_action,
        privacyPolicyVersion: form.privacy_policy_version,
      };
    },
  };
}
