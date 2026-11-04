import type {
  ConversionDestination,
  ConversionDestinationName,
  DeliveryAttemptResult,
  DeliveryRepository,
  LeadConversionSource,
  LeadConversionSourceReader,
  OutboxEventRecord,
  OutboxLockResult,
  OutboxPublisher,
  OutboxRepository,
  OutboxStatus,
  ServerConversionEvent,
  StaleOutboxQuery,
  TrackingTelemetry,
} from '#/modules/tracking/application/ports.ts';
import {
  createDispatchOutboxEvent,
  type DispatchOutboxEvent,
} from '#/modules/tracking/application/dispatch-outbox-event.ts';
import {
  createSweepOutbox,
  type SweepOutbox,
} from '#/modules/tracking/application/sweep-outbox.ts';
import { Delivery } from '#/modules/tracking/domain/delivery.ts';
import type { Destination } from '#/modules/tracking/domain/destinations.ts';
import { aLeadFacts, LEAD_ID } from '#/modules/tracking/domain/lead-facts.fixture.ts';
import type { LeadCapturedPayload } from '#/modules/tracking/public-api.ts';
import type {
  CorrelationId,
  LeadId,
  OutboxEventId,
  SubmissionId,
  WorkspaceId,
} from '#/shared/ids.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';
import { CallLog } from './call-log.ts';
import { FakeClock } from './clock.ts';
import { FakeUnitOfWork, TransactionRegistry, type Transactional } from './transactions.ts';

export const WORKSPACE_ID = '0193aaaa-0000-7000-8000-00000000000a' as WorkspaceId;
export const OTHER_WORKSPACE_ID = '0193aaaa-0000-7000-8000-00000000000b' as WorkspaceId;
export const SUBMISSION_ID = '0193aaaa-0000-7000-8000-0000000000e1' as SubmissionId;
export const CORRELATION_ID = '0193aaaa-0000-7000-8000-0000000000c1' as CorrelationId;

const FIRST_EVENT_NUMBER = 0xb1;

interface StoredOutboxEvent {
  readonly record: OutboxEventRecord;
  readonly nextAttemptAt: Date;
  readonly processedAt: Date | null;
}

/** In-memory `tracking.outbox_events` that rolls back with the fake transaction. */
export class FakeOutboxRepository implements OutboxRepository, Transactional {
  #rows: readonly StoredOutboxEvent[] = [];
  readonly #registry: TransactionRegistry;
  readonly #log: CallLog | undefined;
  /** Rows "locked by another transaction": `lockById` reports them as busy (SKIP LOCKED). */
  readonly lockedByOthers = new Set<string>();

  constructor(registry: TransactionRegistry, log?: CallLog) {
    this.#registry = registry;
    this.#log = log;
  }

  captureState(): () => void {
    const saved = this.#rows;
    return () => {
      this.#rows = saved;
    };
  }

  /** Test setup: inserts a row directly (as the lead-capture transaction would). */
  seed(record: OutboxEventRecord, nextAttemptAt: Date = record.createdAt): void {
    this.#rows = [...this.#rows, { record, nextAttemptAt, processedAt: null }];
  }

  get(id: OutboxEventId): OutboxEventRecord {
    return this.#find(id).record;
  }

  statusOf(id: OutboxEventId): OutboxStatus {
    return this.#find(id).record.status;
  }

  nextAttemptAt(id: OutboxEventId): Date {
    return this.#find(id).nextAttemptAt;
  }

  processedAt(id: OutboxEventId): Date | null {
    return this.#find(id).processedAt;
  }

  lockById(tx: Transaction, id: OutboxEventId): Promise<OutboxLockResult> {
    this.#log?.record('outbox.lockById');
    const row = this.#rows.find((candidate) => candidate.record.id === id);
    if (row === undefined || !this.#visible(tx, row)) {
      return Promise.resolve({ kind: 'not_found' });
    }
    if (this.lockedByOthers.has(id)) {
      return Promise.resolve({ kind: 'busy' });
    }
    return Promise.resolve({ kind: 'locked', event: row.record });
  }

  markProcessing(tx: Transaction, id: OutboxEventId, lockedUntil: Date): Promise<void> {
    this.#log?.record('outbox.markProcessing');
    this.#update(tx, id, (row) => ({
      ...row,
      record: {
        ...row.record,
        status: 'processing',
        attempts: row.record.attempts + 1,
        lockedUntil,
      },
    }));
    return Promise.resolve();
  }

  release(tx: Transaction, id: OutboxEventId, nextAttemptAt: Date): Promise<void> {
    this.#log?.record('outbox.release');
    this.#update(tx, id, (row) => ({
      ...row,
      nextAttemptAt,
      record: { ...row.record, status: 'pending', lockedUntil: null },
    }));
    return Promise.resolve();
  }

  complete(
    tx: Transaction,
    id: OutboxEventId,
    result: { readonly status: 'done' | 'dead'; readonly processedAt: Date },
  ): Promise<void> {
    this.#log?.record(`outbox.complete:${result.status}`);
    this.#update(tx, id, (row) => ({
      ...row,
      processedAt: result.processedAt,
      record: { ...row.record, status: result.status, lockedUntil: null },
    }));
    return Promise.resolve();
  }

  recordRepublish(tx: Transaction, id: OutboxEventId, nextAttemptAt: Date): Promise<void> {
    this.#log?.record('outbox.recordRepublish');
    this.#update(tx, id, (row) => ({
      ...row,
      nextAttemptAt,
      record: {
        ...row.record,
        status: 'pending',
        attempts: row.record.attempts + 1,
        lockedUntil: null,
      },
    }));
    return Promise.resolve();
  }

  listStale(tx: Transaction, query: StaleOutboxQuery): Promise<readonly OutboxEventRecord[]> {
    this.#log?.record('outbox.listStale');
    const stale = this.#rows
      .filter((row) => this.#visible(tx, row) && !this.lockedByOthers.has(row.record.id))
      .filter((row) => isStale(row, query))
      .sort((a, b) => a.record.createdAt.getTime() - b.record.createdAt.getTime())
      .slice(0, query.limit);
    return Promise.resolve(stale.map((row) => row.record));
  }

  #find(id: OutboxEventId): StoredOutboxEvent {
    const row = this.#rows.find((candidate) => candidate.record.id === id);
    if (row === undefined) throw new Error(`outbox event ${id} is not in the fake table`);
    return row;
  }

  #update(
    tx: Transaction,
    id: OutboxEventId,
    change: (row: StoredOutboxEvent) => StoredOutboxEvent,
  ): void {
    const current = this.#find(id);
    this.#registry.assertWritable(tx, current.record.workspaceId);
    this.#rows = this.#rows.map((row) => (row.record.id === id ? change(row) : row));
  }

  /** RLS: a transaction only sees rows of its own workspace. */
  #visible(tx: Transaction, row: StoredOutboxEvent): boolean {
    try {
      this.#registry.assertWritable(tx, row.record.workspaceId);
      return true;
    } catch {
      return false;
    }
  }
}

function isStale(row: StoredOutboxEvent, query: StaleOutboxQuery): boolean {
  const { record } = row;
  const pendingAndDue =
    record.status === 'pending' &&
    row.nextAttemptAt <= query.now &&
    record.createdAt < query.createdBefore;
  const abandoned =
    record.status === 'processing' &&
    (record.lockedUntil === null || record.lockedUntil < query.now);
  return pendingAndDue || abandoned;
}

interface StoredDelivery {
  readonly workspaceId: WorkspaceId;
  readonly delivery: Delivery;
}

/** In-memory `tracking.deliveries` with the `UNIQUE (outbox_event_id, destination)` rule. */
export class FakeDeliveryRepository implements DeliveryRepository, Transactional {
  #rows: readonly StoredDelivery[] = [];
  readonly #registry: TransactionRegistry;
  /** When true, `save` reports that the stored delivery was already terminal. */
  rejectSaves = false;

  constructor(registry: TransactionRegistry) {
    this.#registry = registry;
  }

  captureState(): () => void {
    const saved = this.#rows;
    return () => {
      this.#rows = saved;
    };
  }

  all(): readonly Delivery[] {
    return this.#rows.map((row) => row.delivery);
  }

  forEvent(outboxEventId: OutboxEventId): readonly Delivery[] {
    return this.all().filter((delivery) => delivery.outboxEventId === outboxEventId);
  }

  /** Test setup: a delivery that already exists (e.g. `sent` by a previous dispatch). */
  seed(workspaceId: WorkspaceId, delivery: Delivery): void {
    this.#rows = [...this.#rows, { workspaceId, delivery }];
  }

  ensureOpen(
    tx: Transaction,
    workspaceId: WorkspaceId,
    outboxEventId: OutboxEventId,
    destinations: readonly Destination[],
  ): Promise<void> {
    this.#registry.assertWritable(tx, workspaceId);
    const created = destinations
      .filter(
        (destination) =>
          !this.#rows.some(
            (row) =>
              row.delivery.outboxEventId === outboxEventId &&
              row.delivery.destination === destination,
          ),
      )
      .map((destination) => ({
        workspaceId,
        delivery: Delivery.open(outboxEventId, destination, new Date(0)),
      }));
    this.#rows = [...this.#rows, ...created];
    return Promise.resolve();
  }

  listForEvent(_tx: Transaction, outboxEventId: OutboxEventId): Promise<readonly Delivery[]> {
    return Promise.resolve(
      this.forEvent(outboxEventId).toSorted((a, b) => a.destination.localeCompare(b.destination)),
    );
  }

  save(tx: Transaction, delivery: Delivery): Promise<boolean> {
    const current = this.#rows.find(
      (row) =>
        row.delivery.outboxEventId === delivery.outboxEventId &&
        row.delivery.destination === delivery.destination,
    );
    if (current === undefined) throw new Error('delivery was never created');
    this.#registry.assertWritable(tx, current.workspaceId);
    if (this.rejectSaves || !current.delivery.isOpen) return Promise.resolve(false);
    this.#rows = this.#rows.map((row) => (row === current ? { ...row, delivery } : row));
    return Promise.resolve(true);
  }
}

/** Facts keyed by lead id; a missing key (or `null`) is a lead that no longer exists/was anonymized. */
export class FakeLeadSourceReader implements LeadConversionSourceReader {
  readonly #sources = new Map<string, LeadConversionSource | null>();
  loads = 0;

  set(leadId: LeadId, source: LeadConversionSource | null): void {
    this.#sources.set(leadId, source);
  }

  load(
    _tx: Transaction,
    _workspaceId: WorkspaceId,
    payload: LeadCapturedPayload,
  ): Promise<LeadConversionSource | null> {
    this.loads += 1;
    return Promise.resolve(this.#sources.get(payload.lead_id) ?? null);
  }
}

/** A destination that records every event it receives and replays scripted results. */
export class FakeDestination implements ConversionDestination {
  readonly name: ConversionDestinationName;
  readonly received: ServerConversionEvent[] = [];
  /** Results returned in order; once exhausted every call is `sent`. */
  readonly script: DeliveryAttemptResult[] = [];
  throwOnSend = false;
  /** Runs at the start of every call (e.g. to assert no transaction is open). */
  onSend: (() => void) | null = null;
  readonly #log: CallLog | undefined;

  constructor(name: ConversionDestinationName, log?: CallLog) {
    this.name = name;
    this.#log = log;
  }

  get calls(): number {
    return this.received.length;
  }

  send(event: ServerConversionEvent): Promise<DeliveryAttemptResult> {
    this.#log?.record(`${this.name}.send`);
    this.onSend?.();
    this.received.push(event);
    if (this.throwOnSend) return Promise.reject(new Error('destination exploded'));
    return Promise.resolve(
      this.script.shift() ?? { status: 'sent', httpStatus: 200, externalRef: 'fbtrace_fake' },
    );
  }
}

export class FakeOutboxPublisher implements OutboxPublisher {
  readonly published: OutboxEventId[] = [];
  readonly correlationIds: CorrelationId[] = [];
  /** Event ids whose publish rejects (QStash down). */
  readonly failing = new Set<string>();

  publish(
    outboxEventId: OutboxEventId,
    options: { readonly correlationId: CorrelationId },
  ): Promise<void> {
    if (this.failing.has(outboxEventId)) return Promise.reject(new Error('qstash unavailable'));
    this.published.push(outboxEventId);
    this.correlationIds.push(options.correlationId);
    return Promise.resolve();
  }
}

type DeliveryRecorded = Parameters<TrackingTelemetry['deliveryRecorded']>[0];
type OutboxDead = Parameters<TrackingTelemetry['outboxDead']>[0];
type Anomaly = Parameters<TrackingTelemetry['anomaly']>[0];

export class RecordingTrackingTelemetry implements TrackingTelemetry {
  readonly deliveries: DeliveryRecorded[] = [];
  readonly lags: number[] = [];
  readonly dead: OutboxDead[] = [];
  readonly anomalies: Anomaly[] = [];

  deliveryRecorded(event: DeliveryRecorded): void {
    this.deliveries.push(event);
  }

  outboxLag(seconds: number): void {
    this.lags.push(seconds);
  }

  outboxDead(event: OutboxDead): void {
    this.dead.push(event);
  }

  anomaly(event: Anomaly): void {
    this.anomalies.push(event);
  }
}

export interface SeedEventOptions {
  readonly id?: OutboxEventId;
  readonly leadId?: LeadId;
  readonly workspaceId?: WorkspaceId;
  readonly status?: OutboxStatus;
  readonly attempts?: number;
  readonly createdAt?: Date;
  readonly nextAttemptAt?: Date;
  readonly lockedUntil?: Date | null;
  readonly eventType?: OutboxEventRecord['eventType'];
  readonly payload?: OutboxEventRecord['payload'];
  /** Facts of the lead; `null` means the lead is gone/anonymized. */
  readonly source?: LeadConversionSource | null;
}

export interface TrackingHarnessOptions {
  readonly destinationNames?: readonly ConversionDestinationName[];
  /** Fixed jitter draw; defaults to 0.5. */
  readonly random?: number;
  readonly batchSize?: number;
}

export interface TrackingHarness {
  readonly log: CallLog;
  readonly clock: FakeClock;
  readonly registry: TransactionRegistry;
  readonly unitOfWork: FakeUnitOfWork;
  readonly outbox: FakeOutboxRepository;
  readonly deliveries: FakeDeliveryRepository;
  readonly sources: FakeLeadSourceReader;
  readonly destinations: Readonly<Record<string, FakeDestination>>;
  readonly meta: FakeDestination;
  readonly publisher: FakeOutboxPublisher;
  readonly telemetry: RecordingTrackingTelemetry;
  readonly dispatch: DispatchOutboxEvent;
  readonly sweep: SweepOutbox;
  seedEvent(options?: SeedEventOptions): OutboxEventId;
}

/** Wires both use cases against in-memory fakes; the transaction scope emulates RLS. */
export function createTrackingHarness(options: TrackingHarnessOptions = {}): TrackingHarness {
  const log = new CallLog();
  const clock = new FakeClock();
  const registry = new TransactionRegistry();
  const outbox = new FakeOutboxRepository(registry, log);
  const deliveries = new FakeDeliveryRepository(registry);
  const sources = new FakeLeadSourceReader();
  const unitOfWork = new FakeUnitOfWork(registry, [outbox, deliveries], log);
  const publisher = new FakeOutboxPublisher();
  const telemetry = new RecordingTrackingTelemetry();
  const names = options.destinationNames ?? ['meta_capi'];
  const destinations = Object.fromEntries(
    names.map((name) => [name, new FakeDestination(name, log)] as const),
  );
  const random = (): number => options.random ?? 0.5;
  let eventCounter = FIRST_EVENT_NUMBER;

  function nextEventId(): OutboxEventId {
    eventCounter += 1;
    return `0193aaaa-0000-7000-8000-${eventCounter.toString(16).padStart(12, '0')}` as OutboxEventId;
  }

  function seedEvent(seed: SeedEventOptions = {}): OutboxEventId {
    const id = seed.id ?? nextEventId();
    const leadId = seed.leadId ?? LEAD_ID;
    const createdAt = seed.createdAt ?? clock.now();
    outbox.seed(
      {
        id,
        workspaceId: seed.workspaceId ?? WORKSPACE_ID,
        eventType: seed.eventType ?? 'lead.captured',
        payload:
          seed.payload === undefined
            ? { lead_id: leadId, submission_id: SUBMISSION_ID }
            : seed.payload,
        status: seed.status ?? 'pending',
        attempts: seed.attempts ?? 0,
        lockedUntil: seed.lockedUntil ?? null,
        createdAt,
      },
      seed.nextAttemptAt ?? createdAt,
    );
    sources.set(leadId, seed.source === undefined ? aLeadFacts({ leadId }) : seed.source);
    return id;
  }

  const common = { unitOfWork, outbox, telemetry, clock, random };
  return {
    log,
    clock,
    registry,
    unitOfWork,
    outbox,
    deliveries,
    sources,
    destinations,
    meta: destinations.meta_capi ?? new FakeDestination('meta_capi', log),
    publisher,
    telemetry,
    dispatch: createDispatchOutboxEvent({
      ...common,
      deliveries,
      sources,
      destinations: Object.values(destinations),
    }),
    sweep: createSweepOutbox({ ...common, publisher, batchSize: options.batchSize }),
    seedEvent,
  };
}
