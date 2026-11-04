import { z } from 'zod';
import { unwrapTransaction } from '#/platform/db/transaction.ts';
import type { WorkspaceId } from '#/shared/ids.ts';
import { AREAS_OF_EXPERTISE } from '#/shared/lead-profile.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';
import type { IcpSettings, IcpSettingsProvider } from '#/modules/crm/application/ports.ts';

const MAX_PATTERNS = 50;
const MAX_PATTERN_LENGTH = 40;

/** `core.workspaces.settings.icp` (crm §5): snake_case keys, validated before the score uses them. */
const icpJsonSchema = z.strictObject({
  priority_areas: z.array(z.enum(AREAS_OF_EXPERTISE)).max(AREAS_OF_EXPERTISE.length),
  secondary_areas: z.array(z.enum(AREAS_OF_EXPERTISE)).max(AREAS_OF_EXPERTISE.length),
  senior_title_patterns: z.array(z.string().min(1).max(MAX_PATTERN_LENGTH)).max(MAX_PATTERNS),
});

const settingsRowSchema = z.strictObject({ icp: z.unknown() });

/** The stored ICP does not match its schema: a configuration error, never silently replaced by defaults. */
export class InvalidIcpSettingsError extends Error {
  constructor() {
    super('core.workspaces.settings.icp does not match the ICP schema');
    this.name = 'InvalidIcpSettingsError';
  }
}

/**
 * Reads the ICP of the transaction's workspace. RLS (`workspaces_select`) already limits the row to
 * the current workspace; the predicate on `id` repeats it. Null when the workspace has no ICP.
 */
export function createPostgresIcpSettingsProvider(): IcpSettingsProvider {
  return {
    async getIcp(tx: Transaction, workspaceId: WorkspaceId): Promise<IcpSettings | null> {
      const sql = unwrapTransaction(tx);
      const rows = await sql<object[]>`
        SELECT settings -> 'icp' AS icp
        FROM core.workspaces
        WHERE id = ${workspaceId}
      `;
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      const { icp } = settingsRowSchema.parse(row);
      if (icp === null || icp === undefined) {
        return null;
      }
      const parsed = icpJsonSchema.safeParse(icp);
      if (!parsed.success) {
        throw new InvalidIcpSettingsError();
      }
      return {
        priorityAreas: parsed.data.priority_areas,
        secondaryAreas: parsed.data.secondary_areas,
        seniorTitlePatterns: parsed.data.senior_title_patterns,
      };
    },
  };
}
