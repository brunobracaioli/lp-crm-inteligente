import type { CorrelationId, UserId, WorkspaceId } from '#/shared/ids.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';

export type AuditActorType = 'system' | 'user' | 'qstash' | 'ai';
export type AuditResult = 'success' | 'denied' | 'error';

/** One row of core.audit_log. `metadata` must never contain PII (IDs and codes only). */
export interface AuditEntry {
  readonly workspaceId: WorkspaceId;
  readonly occurredAt: Date;
  readonly actorType: AuditActorType;
  readonly actorId: UserId | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly result: AuditResult;
  readonly correlationId: CorrelationId;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface AuditLogWriter {
  append(tx: Transaction, entry: AuditEntry): Promise<void>;
}
