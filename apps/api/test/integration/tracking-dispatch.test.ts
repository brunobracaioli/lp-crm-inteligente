import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDispatchOutboxEvent } from '#/modules/tracking/application/dispatch-outbox-event.ts';
import { createSweepOutbox } from '#/modules/tracking/application/sweep-outbox.ts';
import { PostgresDeliveryRepository } from '#/modules/tracking/infrastructure/postgres-delivery-repository.ts';
import { PostgresLeadConversionSourceReader } from '#/modules/tracking/infrastructure/postgres-lead-conversion-source-reader.ts';
import { PostgresOutboxRepository } from '#/modules/tracking/infrastructure/postgres-outbox-repository.ts';
import type { CorrelationId, OutboxEventId } from '#/shared/ids.ts';
import { FakeClock } from '#test/fakes/clock.ts';
import {
  FakeDestination,
  FakeOutboxPublisher,
  RecordingTrackingTelemetry,
} from '#test/fakes/tracking.ts';
import {
  RUNTIME_DATABASE_URL,
  TestPostgresUnitOfWork,
  connectAdmin,
  connectRuntime,
  deleteWorkspace,
  readDeliveries,
  readOutboxState,
  seedOutboxEvent,
  seedSubmission,
  seedWorkspace,
  type SeedSubmissionOptions,
  type SeededWorkspace,
} from './tracking-db.ts';

const MINUTE_MS = 60_000;
const CORRELATION_ID = randomUUID() as CorrelationId;
const DENIED = {
  analytics_storage: 'denied',
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
} as const;

describe.skipIf(RUNTIME_DATABASE_URL === undefined)(
  'tracking dispatch and sweep on Postgres',
  () => {
    let admin: Sql;
    let runtime: Sql;
    const workspaces: SeededWorkspace[] = [];

    beforeAll(() => {
      admin = connectAdmin();
      runtime = connectRuntime();
    });

    afterAll(async () => {
      for (const workspace of workspaces) {
        await deleteWorkspace(admin, workspace.workspaceId);
      }
      await runtime.end();
      await admin.end();
    });

    /** Real adapters + the real transaction semantics; only the outbound HTTP is faked. */
    function build() {
      const uow = new TestPostgresUnitOfWork(runtime);
      const clock = new FakeClock(new Date());
      const outbox = new PostgresOutboxRepository(uow.resolve);
      const meta = new FakeDestination('meta_capi');
      const publisher = new FakeOutboxPublisher();
      const telemetry = new RecordingTrackingTelemetry();
      const common = { unitOfWork: uow, outbox, telemetry, clock, random: () => 0 };
      return {
        clock,
        meta,
        publisher,
        telemetry,
        dispatch: createDispatchOutboxEvent({
          ...common,
          deliveries: new PostgresDeliveryRepository(uow.resolve, { uuidv7: () => randomUUID() }),
          sources: new PostgresLeadConversionSourceReader(uow.resolve),
          destinations: [meta],
        }),
        sweep: createSweepOutbox({ ...common, publisher }),
      };
    }

    async function seed(options: SeedSubmissionOptions = {}, createdAt?: Date) {
      const workspace = await seedWorkspace(admin);
      workspaces.push(workspace);
      const submission = await seedSubmission(admin, workspace, options);
      const id = await seedOutboxEvent(admin, workspace, submission, {
        ...(createdAt === undefined ? {} : { createdAt }),
      });
      return { workspace, submission, id };
    }

    const command = (workspace: SeededWorkspace, id: OutboxEventId) => ({
      workspaceId: workspace.workspaceId,
      outboxEventId: id,
      correlationId: CORRELATION_ID,
    });

    it('AC-TR-01: consent granted sends one Lead with the submission event_id and stores fbtrace_id', async () => {
      const { workspace, submission, id } = await seed();
      const app = build();

      const outcome = await app.dispatch(command(workspace, id));

      expect(outcome).toEqual({ kind: 'completed' });
      expect(app.meta.received[0]?.eventId).toBe(submission.eventId);
      expect(await readDeliveries(admin, id)).toEqual([
        {
          destination: 'meta_capi',
          status: 'sent',
          attempts: 1,
          last_http_status: 200,
          last_error_code: null,
          external_ref: 'fbtrace_fake',
        },
      ]);
      const state = await readOutboxState(admin, id);
      expect(state.status).toBe('done');
      expect(state.processed_at).not.toBeNull();
    });

    it('AC-TR-02: consent denied records skipped_no_consent and makes no outbound call', async () => {
      const { workspace, id } = await seed({ consent: DENIED });
      const app = build();

      await app.dispatch(command(workspace, id));

      expect(app.meta.calls).toBe(0);
      expect((await readDeliveries(admin, id))[0]).toMatchObject({
        status: 'skipped_no_consent',
        attempts: 0,
      });
    });

    it('AC-TR-04: reprocessing the same event three times sends exactly once and keeps one delivery', async () => {
      const { workspace, id } = await seed();
      const app = build();

      const outcomes = [
        await app.dispatch(command(workspace, id)),
        await app.dispatch(command(workspace, id)),
        await app.dispatch(command(workspace, id)),
      ];

      expect(outcomes.map((outcome) => outcome.kind)).toEqual([
        'completed',
        'already_processed',
        'already_processed',
      ]);
      expect(app.meta.calls).toBe(1);
      expect(await readDeliveries(admin, id)).toHaveLength(1);
    });

    it('AC-TR-04: two concurrent dispatches of one event send once (the loser is told to retry)', async () => {
      const { workspace, id } = await seed();
      const app = build();

      const outcomes = await Promise.all([
        app.dispatch(command(workspace, id)),
        app.dispatch(command(workspace, id)),
      ]);

      expect(app.meta.calls).toBe(1);
      expect(await readDeliveries(admin, id)).toHaveLength(1);
      const kinds = outcomes.map((outcome) => outcome.kind).sort();
      expect(kinds[0]).toBe('completed');
      expect(['already_processed', 'retry_later']).toContain(kinds[1]);
    });

    it('AC-TR-05: a retryable failure leaves the delivery failed and the event pending with a retry time', async () => {
      const { workspace, id } = await seed();
      const app = build();
      app.meta.script.push({ status: 'retryable_failure', httpStatus: 503, errorCode: 'http_5xx' });

      const outcome = await app.dispatch(command(workspace, id));

      expect(outcome).toEqual({ kind: 'retry_later', reason: 'delivery_failed' });
      expect((await readDeliveries(admin, id))[0]).toMatchObject({
        status: 'failed',
        attempts: 1,
        last_http_status: 503,
        last_error_code: 'http_5xx',
      });
      const state = await readOutboxState(admin, id);
      expect(state).toMatchObject({ status: 'pending', attempts: 1, locked_until: null });
      expect(state.next_attempt_at.getTime()).toBeGreaterThan(app.clock.now().getTime());
    });

    it('AC-TR-05: a 4xx failure is dead and never retried', async () => {
      const { workspace, id } = await seed();
      const app = build();
      app.meta.script.push({
        status: 'permanent_failure',
        httpStatus: 400,
        errorCode: 'validation',
      });

      const first = await app.dispatch(command(workspace, id));
      const replay = await app.dispatch(command(workspace, id));

      expect(first).toEqual({ kind: 'completed' });
      expect(replay).toEqual({ kind: 'already_processed' });
      expect(app.meta.calls).toBe(1);
      expect((await readDeliveries(admin, id))[0]?.status).toBe('dead');
      expect((await readOutboxState(admin, id)).status).toBe('dead');
    });

    it('cross-tenant: dispatching with another workspace scope finds nothing and sends nothing', async () => {
      const owner = await seed();
      const intruder = await seedWorkspace(admin);
      workspaces.push(intruder);
      const app = build();

      const outcome = await app.dispatch(command(intruder, owner.id));

      expect(outcome).toEqual({ kind: 'not_found' });
      expect(app.meta.calls).toBe(0);
      expect(await readDeliveries(admin, owner.id)).toEqual([]);
      expect((await readOutboxState(admin, owner.id)).status).toBe('pending');
    });

    it('AC-TR-07: the sweeper republishes a pending event older than 2 minutes, once, and reschedules it', async () => {
      const createdAt = new Date(Date.now() - 6 * MINUTE_MS);
      const { workspace, id } = await seed({}, createdAt);
      const app = build();

      const first = await app.sweep({
        workspaceId: workspace.workspaceId,
        correlationId: CORRELATION_ID,
      });
      const second = await app.sweep({
        workspaceId: workspace.workspaceId,
        correlationId: CORRELATION_ID,
      });

      expect(first).toEqual({ republished: 1, publishFailures: 0, deadLettered: 0 });
      expect(second.republished).toBe(0);
      expect(app.publisher.published).toEqual([id]);
      expect(await readOutboxState(admin, id)).toMatchObject({ status: 'pending', attempts: 1 });
    });

    it('AC-TR-07: a dispatch after the sweeper republish completes the event end to end', async () => {
      const createdAt = new Date(Date.now() - 6 * MINUTE_MS);
      const { workspace, id } = await seed({}, createdAt);
      const app = build();

      await app.sweep({ workspaceId: workspace.workspaceId, correlationId: CORRELATION_ID });
      const outcome = await app.dispatch(command(workspace, id));

      expect(outcome).toEqual({ kind: 'completed' });
      expect(await readOutboxState(admin, id)).toMatchObject({ status: 'done', attempts: 2 });
    });
  },
);
