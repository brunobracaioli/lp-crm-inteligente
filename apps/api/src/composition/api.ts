import type { Hono } from 'hono';
import { composeLeadCapture } from '#/composition/lead-capture.ts';
import { composeTracking } from '#/composition/tracking.ts';
import type { Config } from '#/platform/config/env.ts';
import { createSqlClient } from '#/platform/db/index.ts';
import type { AppEnv } from '#/platform/http/app-env.ts';
import type { Logger } from '#/platform/logger/logger.ts';
import type { Metrics } from '#/platform/metrics/metrics.ts';
import { createUuidV7Generator } from '#/platform/runtime/uuid-v7.ts';

export interface ApiCompositionInput {
  readonly config: Config;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly runInBackground: (task: Promise<unknown>) => void;
}

/** Every route group of the API, sharing one lazy Postgres client and one id generator. */
export function composeApiRoutes(input: ApiCompositionInput): readonly Hono<AppEnv>[] {
  const { config } = input;
  const sql = config.database === undefined ? null : createSqlClient(config.database);
  const ids = createUuidV7Generator();
  const tracking = composeTracking({ ...input, sql, ids });
  const leadCapture = composeLeadCapture({
    ...input,
    sql,
    ids,
    triggerOutboxDispatch: tracking.triggerOutboxDispatch,
  });
  return [...leadCapture, ...tracking.routes];
}
