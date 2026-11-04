import type { IdGenerator } from '#/shared/ids.ts';

/** UUID-shaped, version 7, strictly increasing: `00000000-0000-7000-8000-000000000001`, … */
export class SequentialIdGenerator implements IdGenerator {
  #counter = 0;

  uuidv7(): string {
    this.#counter += 1;
    return `00000000-0000-7000-8000-${this.#counter.toString(16).padStart(12, '0')}`;
  }
}
