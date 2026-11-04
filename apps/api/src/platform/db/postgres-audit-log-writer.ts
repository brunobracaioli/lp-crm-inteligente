import type { AuditEntry, AuditLogWriter } from '#/shared/audit.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';
import { unwrapTransaction } from './transaction.ts';

/** `core.audit_log` (append-only; the table belongs to the shared kernel, not to a module). */
export function createPostgresAuditLogWriter(): AuditLogWriter {
  return {
    async append(tx: Transaction, entry: AuditEntry): Promise<void> {
      const sql = unwrapTransaction(tx);
      await sql`
        INSERT INTO core.audit_log (
          workspace_id, occurred_at, actor_type, actor_id, action, resource_type, resource_id,
          result, correlation_id, metadata
        ) VALUES (
          ${entry.workspaceId}, ${entry.occurredAt}, ${entry.actorType}, ${entry.actorId},
          ${entry.action}, ${entry.resourceType}, ${entry.resourceId}, ${entry.result},
          ${entry.correlationId}, ${sql.json({ ...entry.metadata })}
        )
      `;
    },
  };
}
