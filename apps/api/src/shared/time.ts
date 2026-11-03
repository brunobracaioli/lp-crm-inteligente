/** Time source. Injected everywhere so tests never depend on wall-clock time or real sleeps. */
export interface Clock {
  now(): Date;
  /** Waits `ms` milliseconds (R2: honeypot latency equalisation). Fakes resolve immediately. */
  sleep(ms: number): Promise<void>;
}
