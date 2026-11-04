import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Delivery } from '#/modules/tracking/domain/delivery.ts';
import { PostgresDeliveryRepository } from '#/modules/tracking/infrastructure/postgres-delivery-repository.ts';
import {
  RUNTIME_DATABASE_URL,
  TestPostgresUnitOfWork,
  connectAdmin,
  connectRuntime,
  deleteWorkspace,
  readDeliveries,
  seedOutboxEvent,
  seedSubmission,
  seedWorkspace,
  type SeededWorkspace,
} from './tracking-db.ts';

const NOW = new Date('2026-11-03T12:00:00.000Z');

describe.skipIf(RUNTIME_DATABASE_URL === undefined)('PostgresDeliveryRepository', () => {
  let admin: Sql;
  let runtime: Sql;
  let uow: TestPostgresUnitOfWork;
  let repository: PostgresDeliveryRepository;
  const workspaces: SeededWorkspace[] = [];

  async function newEvent() {
    const workspace = await seedWorkspace(admin);
    workspaces.push(workspace);
    const submission = await seedSubmission(admin, workspace);
    const id = await seedOutboxEvent(admin, workspace, submission);
    return { workspace, id };
  }

  beforeAll(() => {
    admin = connectAdmin();
    runtime = connectRuntime();
    uow = new TestPostgresUnitOfWork(runtime);
    repository = new PostgresDeliveryRepository(uow.resolve, { uuidv7: () => randomUUID() });
  });

  afterAll(async () => {
    for (const workspace of workspaces) {
      await deleteWorkspace(admin, workspace.workspaceId);
    }
    await runtime.end();
    await admin.end();
  });

  it('AC-TR-04: ensureOpen is idempotent, three calls leave exactly one delivery per destination', async () => {
    const { workspace, id } = await newEvent();

    for (let call = 0; call < 3; call += 1) {
      await uow.run(workspace.workspaceId, (tx) =>
        repository.ensureOpen(tx, workspace.workspaceId, id, ['meta_capi', 'ga4_mp']),
      );
    }

    const rows = await readDeliveries(admin, id);
    expect(rows.map((row) => [row.destination, row.status, row.attempts])).toEqual([
      ['ga4_mp', 'pending', 0],
      ['meta_capi', 'pending', 0],
    ]);
  });

  it('listForEvent rehydrates the domain deliveries, ordered by destination', async () => {
    const { workspace, id } = await newEvent();
    await uow.run(workspace.workspaceId, (tx) =>
      repository.ensureOpen(tx, workspace.workspaceId, id, ['meta_capi', 'ga4_mp']),
    );

    const deliveries = await uow.run(workspace.workspaceId, (tx) =>
      repository.listForEvent(tx, id),
    );

    expect(deliveries.map((delivery) => delivery.destination)).toEqual(['ga4_mp', 'meta_capi']);
    expect(deliveries.every((delivery) => delivery instanceof Delivery && delivery.isOpen)).toBe(
      true,
    );
  });

  it('save persists a sent delivery with its external reference', async () => {
    const { workspace, id } = await newEvent();
    await uow.run(workspace.workspaceId, (tx) =>
      repository.ensureOpen(tx, workspace.workspaceId, id, ['meta_capi']),
    );
    const [open] = await uow.run(workspace.workspaceId, (tx) => repository.listForEvent(tx, id));
    const sent = open?.recordAttempt(
      { status: 'sent', httpStatus: 200, externalRef: 'fbtrace_1' },
      NOW,
    );
    if (!sent?.ok) throw new Error('fixture');

    const saved = await uow.run(workspace.workspaceId, (tx) => repository.save(tx, sent.value));

    expect(saved).toBe(true);
    expect(await readDeliveries(admin, id)).toEqual([
      {
        destination: 'meta_capi',
        status: 'sent',
        attempts: 1,
        last_http_status: 200,
        last_error_code: null,
        external_ref: 'fbtrace_1',
      },
    ]);
  });

  it('save persists a retryable failure, then the next attempt, keeping the attempts count', async () => {
    const { workspace, id } = await newEvent();
    await uow.run(workspace.workspaceId, (tx) =>
      repository.ensureOpen(tx, workspace.workspaceId, id, ['meta_capi']),
    );
    const [open] = await uow.run(workspace.workspaceId, (tx) => repository.listForEvent(tx, id));
    const failed = open?.recordAttempt(
      { status: 'retryable_failure', httpStatus: 503, errorCode: 'http_5xx' },
      NOW,
    );
    if (!failed?.ok) throw new Error('fixture');
    await uow.run(workspace.workspaceId, (tx) => repository.save(tx, failed.value));

    const [reloaded] = await uow.run(workspace.workspaceId, (tx) =>
      repository.listForEvent(tx, id),
    );

    expect(reloaded).toMatchObject({ status: 'failed', attempts: 1, lastErrorCode: 'http_5xx' });
    expect(reloaded?.isOpen).toBe(true);
  });

  it('save never regresses a terminal delivery (returns false)', async () => {
    const { workspace, id } = await newEvent();
    await uow.run(workspace.workspaceId, (tx) =>
      repository.ensureOpen(tx, workspace.workspaceId, id, ['meta_capi']),
    );
    const [open] = await uow.run(workspace.workspaceId, (tx) => repository.listForEvent(tx, id));
    const sent = open?.recordAttempt({ status: 'sent', httpStatus: 200, externalRef: null }, NOW);
    const dead = open?.recordAttempt(
      { status: 'permanent_failure', httpStatus: 400, errorCode: 'x' },
      NOW,
    );
    if (sent === undefined || !sent.ok || !dead?.ok) throw new Error('fixture');
    await uow.run(workspace.workspaceId, (tx) => repository.save(tx, sent.value));

    const overwritten = await uow.run(workspace.workspaceId, (tx) =>
      repository.save(tx, dead.value),
    );

    expect(overwritten).toBe(false);
    expect((await readDeliveries(admin, id))[0]?.status).toBe('sent');
  });

  it('cross-tenant: another workspace sees and changes nothing', async () => {
    const owner = await newEvent();
    const intruder = await newEvent();
    await uow.run(owner.workspace.workspaceId, (tx) =>
      repository.ensureOpen(tx, owner.workspace.workspaceId, owner.id, ['meta_capi']),
    );
    const [open] = await uow.run(owner.workspace.workspaceId, (tx) =>
      repository.listForEvent(tx, owner.id),
    );
    const sent = open?.recordAttempt({ status: 'sent', httpStatus: 200, externalRef: null }, NOW);
    if (!sent?.ok) throw new Error('fixture');

    const seen = await uow.run(intruder.workspace.workspaceId, (tx) =>
      repository.listForEvent(tx, owner.id),
    );
    const saved = await uow.run(intruder.workspace.workspaceId, (tx) =>
      repository.save(tx, sent.value),
    );

    expect(seen).toEqual([]);
    expect(saved).toBe(false);
    expect((await readDeliveries(admin, owner.id))[0]?.status).toBe('pending');
  });

  it('cross-tenant: ensureOpen cannot create a delivery for an event of another workspace', async () => {
    const owner = await newEvent();
    const intruder = await newEvent();

    await expect(
      uow.run(intruder.workspace.workspaceId, (tx) =>
        repository.ensureOpen(tx, intruder.workspace.workspaceId, owner.id, ['meta_capi']),
      ),
    ).rejects.toThrow();

    expect(await readDeliveries(admin, owner.id)).toEqual([]);
  });
});
