import { Writable } from 'node:stream';
import { createApp } from '#/app.ts';
import { loadConfig } from '#/platform/config/env.ts';
import { createLogger } from '#/platform/logger/logger.ts';
import { createRecordingMetrics } from '#/platform/metrics/metrics.ts';
import type { SubmitLead } from '#/modules/lead-capture/application/submit-lead.ts';
import { createLeadCaptureRoutes } from '#/modules/lead-capture/presentation/http.ts';
import {
  CLIENT_IP,
  createSubmitLeadHarness,
  IDEMPOTENCY_KEY,
  ORIGIN,
  validBody,
} from '#test/fakes/submit-lead-harness.ts';

export { CLIENT_IP, IDEMPOTENCY_KEY, ORIGIN, validBody };

export const LEADS_PATH = '/v1/leads';
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Header overrides: a string sets the header, `null` removes a default one. */
export type HeaderOverrides = Readonly<Record<string, string | null>>;

export interface LeadAppOptions {
  readonly submitLead?: SubmitLead;
  readonly trustVercelProxy?: boolean;
}

export interface PostOptions {
  readonly headers?: HeaderOverrides;
  /** Sent verbatim when a string, JSON-encoded otherwise. */
  readonly body?: unknown;
}

function defaultHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Origin: ORIGIN,
    'Idempotency-Key': IDEMPOTENCY_KEY,
    'User-Agent': 'TestBrowser/1.0',
    'X-Real-IP': CLIENT_IP,
  };
}

function buildHeaders(overrides: HeaderOverrides = {}): Headers {
  const headers = new Headers(defaultHeaders());
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) {
      headers.delete(name);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

/**
 * The real app (`createApp`) with the lead-capture routes over the fake harness, a capturing
 * logger and recording metrics. `submitLead` can be replaced to script a precise use case result.
 */
export function buildLeadApp(options: LeadAppOptions = {}) {
  const harness = createSubmitLeadHarness();
  const logLines: string[] = [];
  const logDestination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logLines.push(chunk.toString('utf8'));
      callback();
    },
  });
  const metrics = createRecordingMetrics();
  const routes = createLeadCaptureRoutes({
    submitLead: options.submitLead ?? harness.submitLead,
    metrics,
    clientIp: { trustVercelProxy: options.trustVercelProxy ?? true },
  });
  const app = createApp({
    config: loadConfig({ APP_ENV: 'development', CORS_ALLOWED_ORIGINS: ORIGIN }),
    logger: createLogger({ level: 'debug', appEnv: 'test', destination: logDestination }),
    routes: [routes],
  });

  const post = (post: PostOptions = {}): Promise<Response> =>
    Promise.resolve(
      app.request(LEADS_PATH, {
        method: 'POST',
        headers: buildHeaders(post.headers),
        body: typeof post.body === 'string' ? post.body : JSON.stringify(post.body ?? validBody()),
      }),
    );

  const preflight = (origin: string): Promise<Response> =>
    Promise.resolve(
      app.request(LEADS_PATH, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type,idempotency-key',
        },
      }),
    );

  return { app, harness, metrics, logLines, post, preflight };
}

export type LeadApp = ReturnType<typeof buildLeadApp>;
