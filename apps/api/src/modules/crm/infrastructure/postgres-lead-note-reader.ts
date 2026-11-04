import { z } from 'zod';
import { unwrapTransaction } from '#/platform/db/transaction.ts';
import type { LeadId, UserId, WorkspaceId } from '#/shared/ids.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';
import type { LeadNoteReader, StoredNote } from '#/modules/crm/application/commands/ports.ts';

const noteRowSchema = z.strictObject({
  id: z.guid(),
  actor_id: z.guid().nullable(),
  data: z.strictObject({ body: z.string() }),
  created_at: z.date(),
});

/** A `note_added` row of `crm.lead_activities` (replay of an idempotent `POST …/notes`). */
export function createPostgresLeadNoteReader(): LeadNoteReader {
  return {
    async find(
      tx: Transaction,
      workspaceId: WorkspaceId,
      leadId: LeadId,
      noteId: string,
    ): Promise<StoredNote | null> {
      const sql = unwrapTransaction(tx);
      const rows = await sql<object[]>`
        SELECT id, actor_id, data, created_at
        FROM crm.lead_activities
        WHERE workspace_id = ${workspaceId} AND lead_id = ${leadId} AND id = ${noteId}
          AND type = 'note_added'
      `;
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      const note = noteRowSchema.parse(row);
      return {
        id: note.id,
        actorId: note.actor_id as UserId | null,
        body: note.data.body,
        createdAt: note.created_at,
      };
    },
  };
}
