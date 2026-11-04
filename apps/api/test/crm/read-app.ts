import { Writable } from 'node:stream';
import type { Hono } from 'hono';
import { createApp } from '#/app.ts';
import type { StaffGuards, StaffPrincipal, StaffRole } from '#/platform/auth/staff.ts';
import { loadConfig } from '#/platform/config/env.ts';
import { HttpProblem } from '#/platform/errors/problem.ts';
import type { AppEnv } from '#/platform/http/app-env.ts';
import { createLogger } from '#/platform/logger/logger.ts';
import type { LeadQueries } from '#/modules/crm/application/queries/ports.ts';
import type { UnitOfWork } from '#/shared/unit-of-work.ts';
import { createGetLeadDetail } from '#/modules/crm/application/queries/get-lead-detail.ts';
import {
  createListLeads,
  createSearchLeads,
} from '#/modules/crm/application/queries/list-leads.ts';
import { createCrmReadRoutes } from '#/modules/crm/presentation/read-routes.ts';
import { FakeClock } from '#test/fakes/clock.ts';
import {
  InMemoryLeadQueries,
  USER_A,
  WORKSPACE_A,
  aCursorCodec,
  aFakeUnitOfWork,
} from '#test/fakes/crm-read.ts';

export const LIST_PATH = '/v1/crm/leads';
export const SEARCH_PATH = '/v1/crm/leads/search';
export const detailPath = (id: string): string => `${LIST_PATH}/${id}`;

export function aPrincipal(overrides: Partial<StaffPrincipal> = {}): StaffPrincipal {
  return {
    userId: USER_A,
    workspaceId: WORKSPACE_A,
    role: 'sales',
    displayName: 'Marina Souza',
    aal: 'aal1',
    mfaVerifiedAt: null,
    ...overrides,
  };
}

export interface BuildReadAppOptions {
  /** `null` = the (fake) authenticator rejects the request with 401. */
  readonly principal?: StaffPrincipal | null;
}

/**
 * The real app (`createApp`: security headers, correlation, body limit, error handler) with the CRM
 * read routes over the real use cases, an in-memory read model and fake guards. The fake
 * `authenticate` installs a test `StaffPrincipal`; the fake limiter records its calls.
 */
export function buildReadApp(options: BuildReadAppOptions = {}) {
  return buildReadAppOn(new InMemoryLeadQueries(), aFakeUnitOfWork(), options);
}

/** Same wiring over any read model and unit of work (the integration suite passes Postgres). */
export function buildReadAppOn<Queries extends LeadQueries, Uow extends UnitOfWork>(
  queries: Queries,
  unitOfWork: Uow,
  options: BuildReadAppOptions = {},
) {
  const clock = new FakeClock();
  const cursors = aCursorCodec(clock);
  const guardCalls: string[] = [];
  const rateLimits: { bucket: string; fail: string }[] = [];
  const state = { principal: options.principal === undefined ? aPrincipal() : options.principal };

  const guards: StaffGuards = {
    authenticate: async (c, next) => {
      guardCalls.push('authenticate');
      if (state.principal === null) throw new HttpProblem(401, 'unauthorized');
      c.set('staff', state.principal);
      await next();
    },
    rateLimit: (bucket, fail) => {
      rateLimits.push({ bucket, fail });
      return async (_c, next) => {
        guardCalls.push('rateLimit');
        await next();
      };
    },
  };

  const deps = { unitOfWork, queries, cursors };
  const routes = createCrmReadRoutes({
    guards,
    listLeads: createListLeads(deps),
    searchLeads: createSearchLeads(deps),
    getLeadDetail: createGetLeadDetail(deps),
  });

  const logLines: string[] = [];
  const logDestination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logLines.push(chunk.toString('utf8'));
      callback();
    },
  });
  const app = createApp({
    config: loadConfig({ APP_ENV: 'development', CORS_ALLOWED_ORIGINS: 'https://crm.example.com' }),
    logger: createLogger({ level: 'debug', appEnv: 'test', destination: logDestination }),
    // The staff routes extend AppEnv with the principal; the root mounts them like any other group.
    routes: [routes as unknown as Hono<AppEnv>],
  });

  const get = (path: string): Promise<Response> =>
    Promise.resolve(app.request(path, { headers: { Authorization: 'Bearer test-token' } }));

  const post = (
    path: string,
    body: unknown,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<Response> =>
    Promise.resolve(
      app.request(path, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
          ...headers,
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    );

  return {
    app,
    routes,
    queries,
    unitOfWork,
    clock,
    guardCalls,
    rateLimits,
    logLines,
    get,
    post,
    setRole: (role: StaffRole) => {
      state.principal = aPrincipal({ role });
    },
    setPrincipal: (principal: StaffPrincipal | null) => {
      state.principal = principal;
    },
  };
}

export type ReadApp = ReturnType<typeof buildReadApp>;
