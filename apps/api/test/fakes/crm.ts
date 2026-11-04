import type { WorkspaceId } from '#/shared/ids.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';
import type {
  IcpSettings,
  IcpSettingsProvider,
  LeadActivityRecord,
  LeadActivityRepository,
  LeadRepository,
  LeadState,
} from '#/modules/crm/application/ports.ts';
import type { CallLog } from './call-log.ts';
import { Table, type TransactionRegistry, type Transactional } from './transactions.ts';

const keyOf = (workspaceId: WorkspaceId, email: string): string => `${workspaceId}:${email}`;

/**
 * In-memory `crm.leads` with the unique index `(workspace_id, email) WHERE anonymized_at IS NULL`
 * and the optimistic lock of `update`. Rolls back with the fake transaction.
 */
export class FakeLeadRepository implements LeadRepository, Transactional {
  /** Runs right before `insertIfAbsent` looks at the index: lets a test simulate a concurrent insert. */
  beforeInsert: (() => void) | null = null;
  /** Number of `update` calls that reported a version conflict. */
  conflicts = 0;
  /** When set, `findActiveByEmailForUpdate` reports no lead even if one exists (stale read). */
  hideExisting = false;

  #leads = new Map<string, LeadState>();
  readonly #registry: TransactionRegistry;
  readonly #log: CallLog | undefined;

  constructor(registry: TransactionRegistry, log?: CallLog) {
    this.#registry = registry;
    this.#log = log;
  }

  captureState(): () => void {
    const saved = new Map(this.#leads);
    return () => {
      this.#leads = saved;
    };
  }

  insertIfAbsent(tx: Transaction, lead: LeadState): Promise<'inserted' | 'exists'> {
    this.#log?.record('leads.insertIfAbsent');
    this.#registry.assertWritable(tx, lead.workspaceId);
    this.beforeInsert?.();
    const key = keyOf(lead.workspaceId, lead.email);
    if (this.#leads.has(key)) {
      return Promise.resolve('exists');
    }
    this.#leads.set(key, lead);
    return Promise.resolve('inserted');
  }

  findActiveByEmailForUpdate(
    tx: Transaction,
    workspaceId: WorkspaceId,
    email: string,
  ): Promise<LeadState | null> {
    this.#log?.record('leads.findActiveByEmailForUpdate');
    this.#registry.assertWritable(tx, workspaceId);
    const found = this.hideExisting ? undefined : this.#leads.get(keyOf(workspaceId, email));
    return Promise.resolve(found?.anonymizedAt === null ? found : null);
  }

  update(
    tx: Transaction,
    lead: LeadState,
    expectedVersion: number,
  ): Promise<'updated' | 'version_conflict'> {
    this.#log?.record('leads.update');
    this.#registry.assertWritable(tx, lead.workspaceId);
    const stored = [...this.#leads.values()].find((candidate) => candidate.id === lead.id);
    if (stored?.version !== expectedVersion) {
      this.conflicts += 1;
      return Promise.resolve('version_conflict');
    }
    this.#leads.delete(keyOf(stored.workspaceId, stored.email));
    this.#leads.set(keyOf(lead.workspaceId, lead.email), { ...lead, version: expectedVersion + 1 });
    return Promise.resolve('updated');
  }

  // --- test helpers (not part of the port) ---

  /** Stores a lead directly, as if it had been committed earlier. */
  seed(lead: LeadState): void {
    this.#leads.set(keyOf(lead.workspaceId, lead.email), lead);
  }

  all(): readonly LeadState[] {
    return [...this.#leads.values()];
  }

  find(workspaceId: WorkspaceId, email: string): LeadState | undefined {
    return this.#leads.get(keyOf(workspaceId, email));
  }
}

export class FakeLeadActivityRepository implements LeadActivityRepository, Transactional {
  readonly #table = new Table<LeadActivityRecord>();
  readonly #registry: TransactionRegistry;
  readonly #log: CallLog | undefined;

  constructor(registry: TransactionRegistry, log?: CallLog) {
    this.#registry = registry;
    this.#log = log;
  }

  get records(): readonly LeadActivityRecord[] {
    return this.#table.rows;
  }

  captureState(): () => void {
    return this.#table.captureState();
  }

  append(tx: Transaction, activity: LeadActivityRecord): Promise<void> {
    this.#log?.record(`activities.append:${activity.type}`);
    this.#registry.assertWritable(tx, activity.workspaceId);
    this.#table.add(activity);
    return Promise.resolve();
  }
}

export class FakeIcpSettingsProvider implements IcpSettingsProvider {
  icp: IcpSettings | null;

  constructor(icp: IcpSettings | null = null) {
    this.icp = icp;
  }

  getIcp(): Promise<IcpSettings | null> {
    return Promise.resolve(this.icp);
  }
}
