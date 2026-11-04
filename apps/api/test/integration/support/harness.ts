import { createHmacHasher } from '#/platform/crypto/hashing.ts';
import type { Sql } from '#/platform/db/client.ts';
import { createPostgresAuditLogWriter } from '#/platform/db/postgres-audit-log-writer.ts';
import { createPostgresUnitOfWork } from '#/platform/db/postgres-unit-of-work.ts';
import type { IdempotencyKey } from '#/shared/ids.ts';
import { createRegisterInboundLead } from '#/modules/crm/public-api.ts';
import { createPostgresIcpSettingsProvider } from '#/modules/crm/infrastructure/postgres-icp-settings-provider.ts';
import { createPostgresLeadActivityRepository } from '#/modules/crm/infrastructure/postgres-lead-activity-repository.ts';
import { createPostgresLeadRepository } from '#/modules/crm/infrastructure/postgres-lead-repository.ts';
import type {
  OutboxWriter,
  SubmitLeadDependencies,
} from '#/modules/lead-capture/application/ports.ts';
import {
  createSubmitLead,
  type SubmitLeadCommand,
  type SubmitLeadResult,
} from '#/modules/lead-capture/application/submit-lead.ts';
import { createPostgresConsentRepository } from '#/modules/lead-capture/infrastructure/postgres-consent-repository.ts';
import { createPostgresFormLookup } from '#/modules/lead-capture/infrastructure/postgres-form-lookup.ts';
import { createPostgresSubmissionRepository } from '#/modules/lead-capture/infrastructure/postgres-submission-repository.ts';
import { createPostgresOutboxWriter } from '#/modules/tracking/infrastructure/postgres-outbox-writer.ts';
import { FakeClock } from '#test/fakes/clock.ts';
import {
  FakeAntiBotVerifier,
  FakeIdempotencyStore,
  FakeOutboxDispatchTrigger,
  FakeRateLimiter,
} from '#test/fakes/lead-capture.ts';
import { aSubmitCommand, validBody, ORIGIN } from '#test/fakes/submit-lead-harness.ts';
import type { WorkspaceFixture } from './fixtures.ts';
import { RandomUuidV7Generator } from './uuid-v7.ts';

const PEPPER = Buffer.alloc(32, 7).toString('base64');

export interface SubmitLeadIntegrationOptions {
  /** Replaces the real outbox adapter (e.g. to make it fail mid-transaction). */
  readonly outbox?: OutboxWriter;
}

/**
 * SubmitLead and the real crm use case wired to the Postgres adapters; only the third-party
 * boundaries (Turnstile, Redis, rate limit, clock, post-commit publish) are the in-memory fakes.
 */
export function createSubmitLeadIntegration(
  sql: Sql,
  fixture: WorkspaceFixture,
  options: SubmitLeadIntegrationOptions = {},
) {
  const ids = new RandomUuidV7Generator();
  const clock = new FakeClock();
  const rateLimiter = new FakeRateLimiter();
  const antiBot = new FakeAntiBotVerifier();
  const idempotency = new FakeIdempotencyStore();
  const dispatch = new FakeOutboxDispatchTrigger();
  const unitOfWork = createPostgresUnitOfWork(sql);
  const registerInboundLead = createRegisterInboundLead({
    leads: createPostgresLeadRepository(),
    activities: createPostgresLeadActivityRepository(),
    icp: createPostgresIcpSettingsProvider(),
    ids,
  });
  const dependencies: SubmitLeadDependencies = {
    forms: createPostgresFormLookup(sql),
    rateLimiter,
    antiBot,
    idempotency,
    unitOfWork,
    submissions: createPostgresSubmissionRepository(),
    consents: createPostgresConsentRepository(),
    outbox: options.outbox ?? createPostgresOutboxWriter(),
    audit: createPostgresAuditLogWriter(),
    registerInboundLead,
    triggerOutboxDispatch: dispatch.trigger,
    clock,
    ids,
    hmac: createHmacHasher(PEPPER),
  };
  const submitLead = createSubmitLead(dependencies);

  /** Valid request for this fixture's form; every call gets a fresh idempotency key and event id. */
  const command = (
    bodyOverrides: Record<string, unknown> = {},
    overrides: Partial<SubmitLeadCommand> = {},
  ): SubmitLeadCommand =>
    aSubmitCommand({
      body: validBody({
        form_key: fixture.formKey,
        tracking: {
          event_id: ids.uuidv7(),
          utm_source: 'meta',
          fbclid: 'IwAR123',
          landing_page_url: `${ORIGIN}/?utm_source=meta`,
        },
        ...bodyOverrides,
      }),
      idempotencyKey: ids.uuidv7() as IdempotencyKey,
      ...overrides,
    });

  const submit = (
    bodyOverrides: Record<string, unknown> = {},
    overrides: Partial<SubmitLeadCommand> = {},
  ): Promise<SubmitLeadResult> => submitLead(command(bodyOverrides, overrides));

  return {
    ids,
    clock,
    rateLimiter,
    antiBot,
    idempotency,
    dispatch,
    unitOfWork,
    dependencies,
    submitLead,
    command,
    submit,
  };
}

export type SubmitLeadIntegration = ReturnType<typeof createSubmitLeadIntegration>;
