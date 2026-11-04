import type { Logger } from '#/platform/logger/logger.ts';
import type { OutboxPublisher } from '#/modules/tracking/application/ports.ts';
import type { TriggerOutboxDispatch } from '#/modules/tracking/public-api.ts';

export interface PostCommitDispatchDependencies {
  readonly publisher: OutboxPublisher;
  readonly logger: Logger;
  /** Keeps the function alive until the promise settles (`waitUntil` of `@vercel/functions`). */
  readonly runInBackground: (task: Promise<unknown>) => void;
}

/**
 * `TriggerOutboxDispatch` (tracking §5.1): publishes the committed event to QStash in the background.
 * Never throws and never delays the response; a failed publish is only logged (IDs and a code), the
 * sweeper republishes events still `pending` (AC-TR-07).
 */
export function createPostCommitOutboxDispatch(
  deps: PostCommitDispatchDependencies,
): TriggerOutboxDispatch {
  return (outboxEventId, correlationId) => {
    try {
      const task = deps.publisher.publish(outboxEventId, { correlationId }).catch(() => {
        deps.logger.warn(
          { outbox_event_id: outboxEventId, correlation_id: correlationId },
          'outbox publish failed; the sweeper will retry',
        );
      });
      deps.runInBackground(task);
    } catch {
      deps.logger.warn(
        { outbox_event_id: outboxEventId, correlation_id: correlationId },
        'outbox publish could not be scheduled; the sweeper will retry',
      );
    }
  };
}
