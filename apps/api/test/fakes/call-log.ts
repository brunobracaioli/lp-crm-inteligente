/** Ordered record of the port calls a use case makes, to assert the order of lead-capture §2. */
export class CallLog {
  readonly entries: string[] = [];

  record(entry: string): void {
    this.entries.push(entry);
  }

  /** Entries starting with `prefix`, in order. */
  matching(prefix: string): string[] {
    return this.entries.filter((entry) => entry.startsWith(prefix));
  }

  clear(): void {
    this.entries.length = 0;
  }
}
