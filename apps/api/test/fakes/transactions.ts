import type { WorkspaceId } from '#/shared/ids.ts';
import type { Transaction, UnitOfWork } from '#/shared/unit-of-work.ts';
import type { CallLog } from './call-log.ts';

/** In-memory state that can be rolled back together with the fake transaction. */
export interface Transactional {
  /** Captures the current state and returns the function that restores it. */
  captureState(): () => void;
}

/** A list of immutable rows whose contents roll back with the transaction. */
export class Table<T> implements Transactional {
  rows: readonly T[] = [];

  add(row: T): void {
    this.rows = [...this.rows, row];
  }

  captureState(): () => void {
    const saved = this.rows;
    return () => {
      this.rows = saved;
    };
  }
}

interface ActiveTransaction {
  readonly token: Transaction;
  readonly workspaceId: WorkspaceId;
}

/**
 * Tracks the open transactions so fake repositories can refuse writes outside one and — like the
 * RLS policy of database §5 — refuse rows of a workspace other than the transaction's scope.
 */
export class TransactionRegistry {
  readonly #active: ActiveTransaction[] = [];

  open(workspaceId: WorkspaceId): Transaction {
    // The brand is a compile-time device; the fake token is just a unique object.
    const token = Object.freeze({}) as unknown as Transaction;
    this.#active.push({ token, workspaceId });
    return token;
  }

  close(token: Transaction): void {
    const index = this.#active.findIndex((entry) => entry.token === token);
    if (index >= 0) {
      this.#active.splice(index, 1);
    }
  }

  get openCount(): number {
    return this.#active.length;
  }

  /** Throws when `tx` is not an open transaction or `workspaceId` is outside its scope. */
  assertWritable(tx: Transaction, workspaceId: WorkspaceId): void {
    const entry = this.#active.find((candidate) => candidate.token === tx);
    if (entry === undefined) {
      throw new Error('fake repository used outside an open transaction');
    }
    if (entry.workspaceId !== workspaceId) {
      throw new Error('RLS: row workspace differs from the transaction workspace');
    }
  }
}

export class FakeUnitOfWork implements UnitOfWork {
  readonly scopes: WorkspaceId[] = [];
  committed = 0;
  rolledBack = 0;
  /** When set, `run` rejects before opening a transaction (database down). */
  failure: Error | null = null;

  readonly #registry: TransactionRegistry;
  readonly #participants: readonly Transactional[];
  readonly #log: CallLog | undefined;

  constructor(
    registry: TransactionRegistry,
    participants: readonly Transactional[],
    log?: CallLog,
  ) {
    this.#registry = registry;
    this.#participants = participants;
    this.#log = log;
  }

  async run<T>(workspaceId: WorkspaceId, work: (tx: Transaction) => Promise<T>): Promise<T> {
    this.#log?.record('uow.run');
    if (this.failure !== null) {
      throw this.failure;
    }
    this.scopes.push(workspaceId);
    const restores = this.#participants.map((participant) => participant.captureState());
    const tx = this.#registry.open(workspaceId);
    try {
      const result = await work(tx);
      this.committed += 1;
      return result;
    } catch (error) {
      for (const restore of restores) {
        restore();
      }
      this.rolledBack += 1;
      throw error;
    } finally {
      this.#registry.close(tx);
    }
  }
}
