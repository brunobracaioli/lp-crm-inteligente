import { z } from 'zod';
import type { Sql } from '#/platform/db/client.ts';
import { translateDatabaseError } from '#/platform/db/unavailable.ts';
import { STAFF_ROLES, type StaffRole } from '#/platform/auth/staff.ts';
import type { UserId, WorkspaceId } from '#/shared/ids.ts';

/**
 * Resolves WHO a verified token belongs to inside the CRM: workspace, role and display name come from
 * `core.workspace_members` for the token `sub`, on every request (threat model C7, C8, C16). Never from claims.
 */

export interface StaffMembership {
  readonly workspaceId: WorkspaceId;
  readonly role: StaffRole;
  readonly displayName: string;
}

export type StaffMembershipLookup =
  | { readonly kind: 'member'; readonly membership: StaffMembership }
  /** No ACTIVE membership: unknown account, deactivated member, or never provisioned. */
  | { readonly kind: 'none' }
  /**
   * More than one active membership. v1 runs a single workspace (ADR-0006) and the API has no way to choose
   * one without trusting the client, so the lookup fails closed instead of guessing. Open question for the owner.
   */
  | { readonly kind: 'ambiguous' };

export interface StaffMembershipResolver {
  resolve(userId: UserId): Promise<StaffMembershipLookup>;
}

const STATEMENT_TIMEOUT_MS = '3000';
/** One row is the answer, a second proves ambiguity; no need to read more. */
const LOOKUP_LIMIT = 2;

const membershipRowSchema = z
  .object({
    workspace_id: z.uuid(),
    role: z.enum(STAFF_ROLES),
    display_name: z.string().min(1).max(80),
  })
  .strict();

/**
 * Postgres adapter. The lookup happens before any workspace is known, so the transaction sets
 * `app.staff_user_id` (the verified `sub`) instead of `app.workspace_id`; the RLS policy of
 * `core.workspace_members` then exposes only the caller's ACTIVE rows (migration 20261104110000). The setting
 * is transaction-local, so it never leaks to the next user of a pooled connection.
 */
export function createPostgresStaffMembershipResolver(sql: Sql): StaffMembershipResolver {
  return {
    async resolve(userId) {
      let rows: readonly unknown[];
      try {
        rows = await sql.begin(async (tx) => {
          await tx`
            SELECT
              pg_catalog.set_config('app.staff_user_id', ${userId}, true),
              pg_catalog.set_config('statement_timeout', ${STATEMENT_TIMEOUT_MS}, true)
          `;
          return tx`
            SELECT workspace_id, role, display_name
            FROM core.workspace_members
            WHERE user_id = ${userId} AND active
            ORDER BY workspace_id
            LIMIT ${LOOKUP_LIMIT}
          `;
        });
      } catch (error) {
        throw translateDatabaseError(error);
      }
      const [first, second] = rows;
      if (first === undefined) return { kind: 'none' };
      if (second !== undefined) return { kind: 'ambiguous' };
      const row = membershipRowSchema.parse(first);
      return {
        kind: 'member',
        membership: {
          workspaceId: row.workspace_id as WorkspaceId,
          role: row.role,
          displayName: row.display_name,
        },
      };
    },
  };
}
