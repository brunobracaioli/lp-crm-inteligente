import { setTimeout as delay } from 'node:timers/promises';
import type { Clock } from '#/shared/time.ts';

/** Wall-clock time source for the composition root; tests inject a fake `Clock` instead. */
export const systemClock: Clock = {
  now: () => new Date(),
  sleep: async (ms) => {
    await delay(ms);
  },
};
