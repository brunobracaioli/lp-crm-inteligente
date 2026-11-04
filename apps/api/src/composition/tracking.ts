import type { Hono } from 'hono';
import type { Config } from '#/platform/config/env.ts';
import { createPostgresUnitOfWork, type Sql, unwrapTransaction } from '#/platform/db/index.ts';
import type { AppEnv } from '#/platform/http/app-env.ts';
import type { Logger } from '#/platform/logger/logger.ts';
import type { Metrics } from '#/platform/metrics/metrics.ts';
import { systemClock } from '#/platform/runtime/system-clock.ts';
import type { IdGenerator, WorkspaceId } from '#/shared/ids.ts';
import { createDispatchOutboxEvent } from '#/modules/tracking/application/dispatch-outbox-event.ts';
import type { ConversionDestination } from '#/modules/tracking/application/ports.ts';
import { createSweepOutbox } from '#/modules/tracking/application/sweep-outbox.ts';
import { Ga4MeasurementProtocolClient } from '#/modules/tracking/infrastructure/ga4-mp-client.ts';
import { MetaCapiClient } from '#/modules/tracking/infrastructure/meta-capi-client.ts';
import { createPostCommitOutboxDispatch } from '#/modules/tracking/infrastructure/post-commit-dispatch.ts';
import { PostgresDeliveryRepository } from '#/modules/tracking/infrastructure/postgres-delivery-repository.ts';
import { PostgresLeadConversionSourceReader } from '#/modules/tracking/infrastructure/postgres-lead-conversion-source-reader.ts';
import { PostgresOutboxRepository } from '#/modules/tracking/infrastructure/postgres-outbox-repository.ts';
import {
  QstashOutboxPublisher,
  createQstashClient,
} from '#/modules/tracking/infrastructure/qstash-publisher.ts';
import { QstashSignatureVerifier } from '#/modules/tracking/infrastructure/qstash-signature.ts';
import { LoggingTrackingTelemetry } from '#/modules/tracking/infrastructure/tracking-telemetry.ts';
import { createOutboxRoutes } from '#/modules/tracking/presentation/http.ts';
import type { TriggerOutboxDispatch } from '#/modules/tracking/public-api.ts';

export interface TrackingCompositionInput {
  readonly config: Config;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly sql: Sql | null;
  readonly ids: IdGenerator;
  /** `waitUntil` of `@vercel/functions`. */
  readonly runInBackground: (task: Promise<unknown>) => void;
}

export interface TrackingComposition {
  readonly routes: readonly Hono<AppEnv>[];
  readonly triggerOutboxDispatch: TriggerOutboxDispatch;
}

/** Events stay `pending`; used only when tracking is not configured (development, see env.ts). */
const leavePending: TriggerOutboxDispatch = () => undefined;

/** Enabled conversion destinations; one without credentials is simply not wired (no request made). */
function conversionDestinations(
  config: Config,
  logger: Logger,
  metrics: Metrics,
): ConversionDestination[] {
  const destinations: ConversionDestination[] = [];
  const { pixelId, capiAccessToken, graphApiVersion, testEventCode } = config.meta;
  if (pixelId !== undefined && capiAccessToken !== undefined) {
    destinations.push(
      new MetaCapiClient(
        { pixelId, accessToken: capiAccessToken, graphApiVersion, testEventCode },
        { logger, metrics },
      ),
    );
  } else {
    logger.warn({ destination: 'meta_capi' }, 'conversion destination not configured');
  }
  const { enabled, measurementId, apiSecret } = config.ga4;
  if (enabled && measurementId !== undefined && apiSecret !== undefined) {
    destinations.push(
      new Ga4MeasurementProtocolClient(
        { enabled: true, measurementId, apiSecret },
        { logger, metrics },
      ),
    );
  }
  return destinations;
}

/**
 * Wires Onda 5b: post-commit QStash publish, `/internal/v1/outbox/{dispatch,sweep}` (QStash signature
 * first) and the dispatch/sweep use cases over Postgres. Without QStash, the public base URL, the
 * workspace or the database (development only) no route is mounted and events stay pending.
 */
export function composeTracking(input: TrackingCompositionInput): TrackingComposition {
  const { config, logger, metrics, sql, ids } = input;
  const { qstash, publicApiBaseUrl, defaultWorkspaceId } = config;
  if (
    sql === null ||
    qstash === undefined ||
    publicApiBaseUrl === undefined ||
    defaultWorkspaceId === undefined
  ) {
    logger.warn(
      { routes: '/internal/v1/outbox/*' },
      'tracking not configured; events stay pending',
    );
    return { routes: [], triggerOutboxDispatch: leavePending };
  }

  const publisher = new QstashOutboxPublisher({
    client: createQstashClient({ baseUrl: qstash.url, token: qstash.token }),
    publicApiBaseUrl,
  });
  const unitOfWork = createPostgresUnitOfWork(sql);
  const outbox = new PostgresOutboxRepository(unwrapTransaction);
  const telemetry = new LoggingTrackingTelemetry(logger, metrics);
  const random = Math.random;

  const dispatchOutboxEvent = createDispatchOutboxEvent({
    unitOfWork,
    outbox,
    deliveries: new PostgresDeliveryRepository(unwrapTransaction, ids),
    sources: new PostgresLeadConversionSourceReader(unwrapTransaction),
    destinations: conversionDestinations(config, logger, metrics),
    telemetry,
    clock: systemClock,
    random,
  });
  const sweepOutbox = createSweepOutbox({
    unitOfWork,
    outbox,
    publisher,
    telemetry,
    clock: systemClock,
    random,
  });

  return {
    routes: [
      createOutboxRoutes({
        verifier: new QstashSignatureVerifier(
          { currentSigningKey: qstash.currentSigningKey, nextSigningKey: qstash.nextSigningKey },
          { clock: systemClock, logger, metrics },
        ),
        dispatchOutboxEvent,
        sweepOutbox,
        workspaceId: defaultWorkspaceId as WorkspaceId,
        publicApiBaseUrl,
      }),
    ],
    triggerOutboxDispatch: createPostCommitOutboxDispatch({
      publisher,
      logger,
      runInBackground: input.runInBackground,
    }),
  };
}
