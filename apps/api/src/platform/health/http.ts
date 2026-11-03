import { Hono } from 'hono';
import type { AppEnv } from '#/platform/http/app-env.ts';

/** Liveness only: no version, dependencies or data (OpenAPI getHealth, security: []). */
export const healthRoutes = new Hono<AppEnv>().get('/v1/health', (c) => c.json({ status: 'ok' }));
