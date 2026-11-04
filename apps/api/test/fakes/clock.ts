import type { Clock } from '#/shared/time.ts';

export const DEFAULT_START = new Date('2026-11-03T12:00:00.000Z');

/** Deterministic clock: `sleep` never waits, it records the request and moves the fake time. */
export class FakeClock implements Clock {
  readonly sleeps: number[] = [];
  #current: Date;

  constructor(start: Date = DEFAULT_START) {
    this.#current = start;
  }

  now(): Date {
    return new Date(this.#current);
  }

  sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.advance(ms);
    return Promise.resolve();
  }

  advance(ms: number): void {
    this.#current = new Date(this.#current.getTime() + ms);
  }
}
