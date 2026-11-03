import type { Logger } from '#/platform/logger/logger.ts';
import type { CorrelationId } from '#/shared/ids.ts';

/** Hono environment shared by every route: per-request correlation id and child logger. */
export interface AppEnv {
  Variables: {
    correlationId: CorrelationId;
    logger: Logger;
  };
}
