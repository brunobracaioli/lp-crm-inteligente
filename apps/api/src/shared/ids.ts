/**
 * Branded identifiers shared across bounded contexts. A brand prevents passing a LeadId where a
 * SubmissionId is expected; values are UUIDs (v7 for aggregates created by the app).
 */
declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type FormId = Brand<string, 'FormId'>;
export type LeadId = Brand<string, 'LeadId'>;
export type SubmissionId = Brand<string, 'SubmissionId'>;
export type EventId = Brand<string, 'EventId'>;
export type OutboxEventId = Brand<string, 'OutboxEventId'>;
export type UserId = Brand<string, 'UserId'>;
export type IdempotencyKey = Brand<string, 'IdempotencyKey'>;
export type CorrelationId = Brand<string, 'CorrelationId'>;

/** Generates identifiers. Infrastructure provides UUID v7; tests provide a deterministic fake. */
export interface IdGenerator {
  uuidv7(): string;
}
