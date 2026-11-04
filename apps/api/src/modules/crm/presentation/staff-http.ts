import type { Context } from 'hono';
import { HttpProblem } from '#/platform/errors/problem.ts';
import type { StaffEnv, StaffPrincipal } from '#/platform/auth/staff.ts';
import type { CommandFailure, RawBody } from '#/modules/crm/application/commands/failures.ts';
import type {
  DenialRecord,
  RecordDenial,
} from '#/modules/crm/application/commands/record-denial.ts';
import type { StaffActor } from '#/modules/crm/application/commands/ports.ts';
import type { CorrelationId, IdempotencyKey, LeadId } from '#/shared/ids.ts';

/** Shared HTTP plumbing of the staff write and privacy routes (guards, body, problems). */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JSON_MEDIA_TYPE = 'application/json';
const UTF8_CHARSET_PARAMETERS: ReadonlySet<string> = new Set(['charset=utf-8', 'charset="utf-8"']);
const HTTP_FORBIDDEN = 403;

export function staffActorOf(principal: StaffPrincipal): StaffActor {
  return { userId: principal.userId, workspaceId: principal.workspaceId, role: principal.role };
}

/** `{id}` of the path: a UUID, normalized to lowercase; anything else is `400 validation_failed`. */
export function parseLeadId(raw: string): LeadId {
  if (!UUID_PATTERN.test(raw)) {
    throw new HttpProblem(400, 'validation_failed', {
      errors: [{ field: 'id', code: 'invalid_format' }],
    });
  }
  return raw.toLowerCase() as LeadId;
}

/** The audit `resource_id` (a uuid column) for an attempt: the path id when valid, else none. */
export function auditableLeadId(raw: string): string | null {
  return UUID_PATTERN.test(raw) ? raw.toLowerCase() : null;
}

/** `Idempotency-Key` header: absent → null; present but not a UUID → `400 validation_failed`. */
export function readIdempotencyKey(c: Context<StaffEnv>): IdempotencyKey | null {
  const header = c.req.header('Idempotency-Key');
  if (header === undefined) {
    return null;
  }
  const value = header.trim();
  if (!UUID_PATTERN.test(value)) {
    throw new HttpProblem(400, 'validation_failed', {
      errors: [{ field: 'Idempotency-Key', code: 'invalid_format' }],
    });
  }
  return value.toLowerCase() as IdempotencyKey;
}

function isJsonContentType(header: string | undefined): boolean {
  if (header === undefined) return false;
  const [mediaType, ...parameters] = header.split(';').map((part) => part.trim().toLowerCase());
  return mediaType === JSON_MEDIA_TYPE && parameters.every((p) => UTF8_CHARSET_PARAMETERS.has(p));
}

/**
 * Reads the JSON body without deciding anything: a wrong media type or malformed JSON becomes a
 * value the use case reports after the resource checks (an unreadable body on a lead of another
 * workspace is still `404`). The 16 KB limit is enforced earlier by the app-level body limit.
 */
export async function readRawBody(c: Context<StaffEnv>): Promise<RawBody> {
  if (!isJsonContentType(c.req.header('Content-Type'))) {
    return { kind: 'unsupported_media_type' };
  }
  // A body over the limit rejects here as the global 413; only the parse below is a body problem.
  const text = await c.req.text();
  try {
    return { kind: 'json', value: JSON.parse(text) as unknown };
  } catch {
    return { kind: 'invalid_json' };
  }
}

/** Maps a command refusal to the contract's problem. Exhaustive: a new code breaks the build. */
export function failureToProblem(failure: CommandFailure): HttpProblem {
  switch (failure.code) {
    case 'not_found':
      return new HttpProblem(404, 'not_found');
    case 'forbidden':
      return new HttpProblem(403, 'forbidden');
    case 'validation_failed':
      return new HttpProblem(400, 'validation_failed', { errors: failure.errors });
    case 'invalid_json':
      return new HttpProblem(400, 'invalid_json');
    case 'unsupported_media_type':
      return new HttpProblem(415, 'unsupported_media_type');
    case 'idempotency_key_missing':
      return new HttpProblem(400, 'idempotency_key_missing');
    case 'idempotency_key_reused':
      return new HttpProblem(422, 'idempotency_key_reused');
    case 'idempotency_in_progress':
      return new HttpProblem(409, 'idempotency_in_progress', {
        retryAfterSeconds: failure.retryAfterSeconds,
      });
    case 'idempotency_unavailable':
      return new HttpProblem(503, 'service_unavailable', { retryAfterSeconds: 5 });
    case 'export_in_progress':
      return new HttpProblem(429, 'rate_limited', { retryAfterSeconds: failure.retryAfterSeconds });
    case 'version_conflict':
      return new HttpProblem(409, 'version_conflict');
    case 'lead_anonymized':
      return new HttpProblem(409, 'lead_anonymized');
    case 'invalid_stage_transition':
      return new HttpProblem(422, 'invalid_stage_transition');
    case 'plan_stale':
      return new HttpProblem(409, 'plan_stale');
  }
}

export interface DenialAudit {
  readonly recordDenial: RecordDenial;
  /** The operation's `x-audit-action`. */
  readonly action: string;
  readonly resourceType: DenialRecord['resourceType'];
  readonly resourceId: string | null;
}

/**
 * Runs a guard (`assertRole`, `assertRecentMfa`) inside the handler so a `403` it throws is first
 * recorded as a `denied` audit row (threat model C26), then rethrown unchanged. Recording is best
 * effort: if the audit store is down the denial is still returned, and the loss is logged.
 */
export async function enforceWithAudit(
  c: Context<StaffEnv>,
  audit: DenialAudit,
  check: (principal: StaffPrincipal) => void,
): Promise<void> {
  const principal = c.get('staff');
  try {
    check(principal);
  } catch (error) {
    if (error instanceof HttpProblem && error.status === HTTP_FORBIDDEN) {
      const recorded = await audit.recordDenial({
        actor: staffActorOf(principal),
        action: audit.action,
        resourceType: audit.resourceType,
        resourceId: audit.resourceId,
        reason: error.code,
        correlationId: c.get('correlationId') satisfies CorrelationId,
      });
      if (!recorded) {
        c.get('logger').warn(
          { action: audit.action, reason: error.code },
          'denial audit not recorded',
        );
      }
    }
    throw error;
  }
}
