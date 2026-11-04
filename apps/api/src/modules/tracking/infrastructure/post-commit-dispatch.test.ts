import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '#/platform/logger/logger.ts';
import { createPostCommitOutboxDispatch } from '#/modules/tracking/infrastructure/post-commit-dispatch.ts';
import type { CorrelationId, OutboxEventId } from '#/shared/ids.ts';

const EVENT_ID = '01920000-0000-7000-8000-000000000001' as OutboxEventId;
const CORRELATION_ID = '01920000-0000-7000-8000-0000000000c1' as CorrelationId;

function setup(publish: () => Promise<void>) {
  const logger = createLogger({ level: 'silent', appEnv: 'development' });
  const warn = vi.spyOn(logger, 'warn');
  const background: Promise<unknown>[] = [];
  const trigger = createPostCommitOutboxDispatch({
    publisher: { publish: vi.fn(publish) },
    logger,
    runInBackground: (task) => background.push(task),
  });
  return { trigger, warn, background };
}

describe('createPostCommitOutboxDispatch', () => {
  it('hands the publish to the background runner without awaiting it', async () => {
    // arrange
    const { trigger, background, warn } = setup(() => Promise.resolve());
    // act
    trigger(EVENT_ID, CORRELATION_ID);
    // assert
    expect(background).toHaveLength(1);
    await Promise.all(background);
    expect(warn).not.toHaveBeenCalled();
  });

  it('swallows a failed publish and logs only ids (AC-TR-07: the sweeper retries)', async () => {
    // arrange
    const { trigger, background, warn } = setup(() => Promise.reject(new Error('qstash down')));
    // act
    trigger(EVENT_ID, CORRELATION_ID);
    await Promise.all(background);
    // assert
    expect(warn).toHaveBeenCalledWith(
      { outbox_event_id: EVENT_ID, correlation_id: CORRELATION_ID },
      'outbox publish failed; the sweeper will retry',
    );
  });

  it('never throws, even when the publisher throws synchronously', () => {
    // arrange
    const { trigger, warn } = setup(() => {
      throw new Error('bad config');
    });
    // act / assert
    expect(() => {
      trigger(EVENT_ID, CORRELATION_ID);
    }).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
  });
});
