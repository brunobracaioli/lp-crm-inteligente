import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresOutboxRepository } from '#/modules/tracking/infrastructure/postgres-outbox-repository.ts';
import type { OutboxEventId } from '#/shared/ids.ts';
import {
  RUNTIME_DATABASE_URL,
  TestPostgresUnitOfWork,
  connectAdmin,
  connectRuntime,
  deleteWorkspace,
  readOutboxState,
  seedOutboxEvent,
  seedSubmission,
  seedWorkspace,
  type SeededWorkspace,
} from './tracking-db.ts';

const MINUTE_MS = 60_000;
const NOW = new Date('2026-11-03T12:00:00.000Z');

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

describe.skipIf(RUNTIME_DATABASE_URL === undefined)('PostgresOutboxRepository', () => {
  let admin: Sql;
  let runtime: Sql;
  let uow: TestPostgresUnitOfWork;
  let repository: PostgresOutboxRepository;
  const workspaces: SeededWorkspace[] = [];

  async function newWorkspace() {
    const workspace = await seedWorkspace(admin);
    workspaces.push(workspace);
    return { workspace, submission: await seedSubmission(admin, workspace) };
  }

  beforeAll(() => {
    admin = connectAdmin();
    runtime = connectRuntime();
    uow = new TestPostgresUnitOfWork(runtime);
    repository = new PostgresOutboxRepository(uow.resolve);
  });

  afterAll(async () => {
    for (const workspace of workspaces) {
      await deleteWorkspace(admin, workspace.workspaceId);
    }
    await runtime.end();
    await admin.end();
  });

  describe('lockById', () => {
    it('returns the event with a validated lead.captured payload', async () => {
      const { workspace, submission } = await newWorkspace();
      const id = await seedOutboxEvent(admin, workspace, submission);

      const result = await uow.run(workspace.workspaceId, (tx) => repository.lockById(tx, id));

      expect(result.kind).toBe('locked');
      if (result.kind !== 'locked') return;
      expect(result.event).toMatchObject({
        id,
        workspaceId: workspace.workspaceId,
        eventType: 'lead.captured',
        status: 'pending',
        attempts: 0,
        lockedUntil: null,
        payload: { lead_id: submission.leadId, submission_id: submission.submissionId },
      });
    });

    it('maps a payload that is not lead.captured-shaped to null instead of trusting it', async () => {
      const { workspace, submission } = await newWorkspace();
      const id = await seedOutboxEvent(admin, workspace, submission);
      await admin`UPDATE tracking.outbox_events SET payload = '{"lead_id":"x","extra":1}'::jsonb WHERE id = ${id}`;

      const result = await uow.run(workspace.workspaceId, (tx) => repository.lockById(tx, id));

      expect(result.kind === 'locked' && result.event.payload).toBeNull();
    });

    it('reports not_found for an unknown id', async () => {
      const { workspace } = await newWorkspace();

      const result = await uow.run(workspace.workspaceId, (tx) =>
        repository.lockById(tx, '0193aaaa-0000-7000-8000-0000000000ff' as OutboxEventId),
      );

      expect(result).toEqual({ kind: 'not_found' });
    });

    it('cross-tenant: an event of another workspace is not_found, never the row', async () => {
      const owner = await newWorkspace();
      const intruder = await newWorkspace();
      const id = await seedOutboxEvent(admin, owner.workspace, owner.submission);

      const result = await uow.run(intruder.workspace.workspaceId, (tx) =>
        repository.lockById(tx, id),
      );

      expect(result).toEqual({ kind: 'not_found' });
    });

    it('reports busy (SKIP LOCKED) while another transaction holds the row', async () => {
      const { workspace, submission } = await newWorkspace();
      const id = await seedOutboxEvent(admin, workspace, submission);

      const concurrent = await uow.run(workspace.workspaceId, async (holder) => {
        const first = await repository.lockById(holder, id);
        // A second transaction on another pool connection while the first still holds the lock.
        const second = await uow.run(workspace.workspaceId, (tx) => repository.lockById(tx, id));
        return { first: first.kind, second };
      });

      expect(concurrent.first).toBe('locked');
      expect(concurrent.second).toEqual({ kind: 'busy' });
    });
  });

  describe('state transitions', () => {
    it('markProcessing takes a lease and counts the attempt', async () => {
      const { workspace, submission } = await newWorkspace();
      const id = await seedOutboxEvent(admin, workspace, submission);
      const lease = new Date(Date.now() + MINUTE_MS);

      await uow.run(workspace.workspaceId, (tx) => repository.markProcessing(tx, id, lease));

      const state = await readOutboxState(admin, id);
      expect(state.status).toBe('processing');
      expect(state.attempts).toBe(1);
      expect(state.locked_until?.getTime()).toBe(lease.getTime());
    });

    it('release returns the event to pending with the lease cleared', async () => {
      const { workspace, submission } = await newWorkspace();
      const id = await seedOutboxEvent(admin, workspace, submission, {
        status: 'processing',
        attempts: 1,
        lockedUntil: new Date(Date.now() + MINUTE_MS),
      });
      const next = new Date(Date.now() + 2 * MINUTE_MS);

      await uow.run(workspace.workspaceId, (tx) => repository.release(tx, id, next));

      const state = await readOutboxState(admin, id);
      expect(state).toMatchObject({ status: 'pending', locked_until: null, attempts: 1 });
      expect(state.next_attempt_at.getTime()).toBe(next.getTime());
    });

    it.each(['done', 'dead'] as const)(
      'complete marks the event %s with processed_at',
      async (status) => {
        const { workspace, submission } = await newWorkspace();
        const id = await seedOutboxEvent(admin, workspace, submission, { status: 'processing' });
        const processedAt = new Date();

        await uow.run(workspace.workspaceId, (tx) =>
          repository.complete(tx, id, { status, processedAt }),
        );

        const state = await readOutboxState(admin, id);
        expect(state.status).toBe(status);
        expect(state.processed_at?.getTime()).toBe(processedAt.getTime());
        expect(state.locked_until).toBeNull();
      },
    );

    it('recordRepublish counts an attempt and reschedules', async () => {
      const { workspace, submission } = await newWorkspace();
      const id = await seedOutboxEvent(admin, workspace, submission, { attempts: 2 });
      const next = new Date(Date.now() + MINUTE_MS);

      await uow.run(workspace.workspaceId, (tx) => repository.recordRepublish(tx, id, next));

      const state = await readOutboxState(admin, id);
      expect(state).toMatchObject({ status: 'pending', attempts: 3, locked_until: null });
      expect(state.next_attempt_at.getTime()).toBe(next.getTime());
    });

    it('cross-tenant: another workspace cannot change the event', async () => {
      const owner = await newWorkspace();
      const intruder = await newWorkspace();
      const id = await seedOutboxEvent(admin, owner.workspace, owner.submission);

      await uow.run(intruder.workspace.workspaceId, (tx) =>
        repository.complete(tx, id, { status: 'dead', processedAt: new Date() }),
      );

      expect((await readOutboxState(admin, id)).status).toBe('pending');
    });
  });

  describe('listStale', () => {
    it('AC-TR-07: selects due pending events older than the threshold and abandoned processing ones, oldest first', async () => {
      const { workspace, submission } = await newWorkspace();
      const stalePending = await seedOutboxEvent(admin, workspace, submission, {
        createdAt: ago(20 * MINUTE_MS),
      });
      const abandoned = await seedOutboxEvent(admin, workspace, submission, {
        createdAt: ago(10 * MINUTE_MS),
        status: 'processing',
        attempts: 1,
        lockedUntil: ago(1),
      });
      const young = await seedOutboxEvent(admin, workspace, submission, {
        createdAt: ago(MINUTE_MS),
      });
      const notDue = await seedOutboxEvent(admin, workspace, submission, {
        createdAt: ago(30 * MINUTE_MS),
        nextAttemptAt: new Date(NOW.getTime() + MINUTE_MS),
      });
      const liveLease = await seedOutboxEvent(admin, workspace, submission, {
        createdAt: ago(30 * MINUTE_MS),
        status: 'processing',
        lockedUntil: new Date(NOW.getTime() + MINUTE_MS),
      });
      const done = await seedOutboxEvent(admin, workspace, submission, {
        createdAt: ago(30 * MINUTE_MS),
        status: 'done',
      });

      const stale = await uow.run(workspace.workspaceId, (tx) =>
        repository.listStale(tx, { now: NOW, createdBefore: ago(2 * MINUTE_MS), limit: 50 }),
      );

      const ids = stale.map((event) => event.id);
      expect(ids).toEqual([stalePending, abandoned]);
      expect(ids).not.toContain(young);
      expect(ids).not.toContain(notDue);
      expect(ids).not.toContain(liveLease);
      expect(ids).not.toContain(done);
    });

    it('is bounded by the limit and oldest first', async () => {
      const { workspace, submission } = await newWorkspace();
      const oldest = await seedOutboxEvent(admin, workspace, submission, {
        createdAt: ago(30 * MINUTE_MS),
      });
      const middle = await seedOutboxEvent(admin, workspace, submission, {
        createdAt: ago(20 * MINUTE_MS),
      });
      await seedOutboxEvent(admin, workspace, submission, { createdAt: ago(10 * MINUTE_MS) });

      const stale = await uow.run(workspace.workspaceId, (tx) =>
        repository.listStale(tx, { now: NOW, createdBefore: ago(2 * MINUTE_MS), limit: 2 }),
      );

      expect(stale.map((event) => event.id)).toEqual([oldest, middle]);
    });

    it('cross-tenant: never lists the events of another workspace', async () => {
      const owner = await newWorkspace();
      const intruder = await newWorkspace();
      await seedOutboxEvent(admin, owner.workspace, owner.submission, {
        createdAt: ago(20 * MINUTE_MS),
      });

      const stale = await uow.run(intruder.workspace.workspaceId, (tx) =>
        repository.listStale(tx, { now: NOW, createdBefore: ago(2 * MINUTE_MS), limit: 50 }),
      );

      expect(stale).toEqual([]);
    });

    it('skips rows locked by a concurrent sweep (FOR UPDATE SKIP LOCKED)', async () => {
      const { workspace, submission } = await newWorkspace();
      const id = await seedOutboxEvent(admin, workspace, submission, {
        createdAt: ago(20 * MINUTE_MS),
      });
      const query = { now: NOW, createdBefore: ago(2 * MINUTE_MS), limit: 50 };

      const concurrent = await uow.run(workspace.workspaceId, async (first) => {
        const mine = await repository.listStale(first, query);
        const theirs = await uow.run(workspace.workspaceId, (tx) =>
          repository.listStale(tx, query),
        );
        return { mine: mine.map((event) => event.id), theirs };
      });

      expect(concurrent.mine).toEqual([id]);
      expect(concurrent.theirs).toEqual([]);
    });
  });
});
