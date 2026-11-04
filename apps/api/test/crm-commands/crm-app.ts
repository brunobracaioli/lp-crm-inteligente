import { Writable } from 'node:stream';
import type { Hono, MiddlewareHandler } from 'hono';
import { createApp } from '#/app.ts';
import type {
  RateLimitFailMode,
  StaffEnv,
  StaffGuards,
  StaffPrincipal,
  StaffRateBucket,
  StaffRole,
} from '#/platform/auth/staff.ts';
import { loadConfig } from '#/platform/config/env.ts';
import { HttpProblem } from '#/platform/errors/problem.ts';
import type { AppEnv } from '#/platform/http/app-env.ts';
import { createLogger } from '#/platform/logger/logger.ts';
import { createCrmDsrRoutes } from '#/modules/crm/presentation/dsr-routes.ts';
import { createCrmWriteRoutes } from '#/modules/crm/presentation/write-routes.ts';
import type { UserId, WorkspaceId } from '#/shared/ids.ts';
import {
  ADMIN_USER,
  OTHER_SALES_USER,
  OWNER_USER,
  SALES_USER,
  VIEWER_USER,
  WORKSPACE_A,
  createCommandHarness,
  type CommandHarness,
} from '#test/fakes/crm-commands.ts';

export const LEAD_JSON = 'application/json';
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const USER_OF_ROLE: Readonly<Record<StaffRole, UserId>> = {
  owner: OWNER_USER,
  admin: ADMIN_USER,
  sales: SALES_USER,
  viewer: VIEWER_USER,
};

export const ALL_ROLES: readonly StaffRole[] = ['owner', 'admin', 'sales', 'viewer'];
export { OTHER_SALES_USER };

export interface PrincipalOptions {
  readonly role?: StaffRole;
  readonly workspaceId?: WorkspaceId;
  readonly aal?: 'aal1' | 'aal2';
  /** Seconds before "now" of the last MFA verification; `null` = no MFA in the token. */
  readonly mfaAgeSeconds?: number | null;
}

/** AAL2 with a MFA verified 60 s ago unless told otherwise. */
export function aPrincipal(clockNow: Date, options: PrincipalOptions = {}): StaffPrincipal {
  const role = options.role ?? 'admin';
  const aal = options.aal ?? 'aal2';
  const age = options.mfaAgeSeconds === undefined ? 60 : options.mfaAgeSeconds;
  return {
    userId: USER_OF_ROLE[role],
    workspaceId: options.workspaceId ?? WORKSPACE_A,
    role,
    displayName: `User ${role}`,
    aal,
    mfaVerifiedAt: age === null ? null : new Date(clockNow.getTime() - age * 1000),
  };
}

export interface LimiterCall {
  readonly bucket: StaffRateBucket;
  readonly fail: RateLimitFailMode;
}

/** Scripted guards standing in for the staff auth middleware (seam of platform/auth/staff.ts). */
export class FakeStaffGuards implements StaffGuards {
  principal: StaffPrincipal | null;
  readonly limiterCalls: LimiterCall[] = [];
  /** Problem thrown by the limiter middleware (429, or 503 on a fail-closed route). */
  limiterProblem: HttpProblem | null = null;

  constructor(principal: StaffPrincipal | null) {
    this.principal = principal;
  }

  readonly authenticate: MiddlewareHandler<StaffEnv> = async (c, next) => {
    if (this.principal === null) {
      throw new HttpProblem(401, 'unauthorized');
    }
    c.set('staff', this.principal);
    await next();
  };

  rateLimit(bucket: StaffRateBucket, fail: RateLimitFailMode): MiddlewareHandler<StaffEnv> {
    return async (_c, next) => {
      this.limiterCalls.push({ bucket, fail });
      if (this.limiterProblem !== null) {
        throw this.limiterProblem;
      }
      await next();
    };
  }
}

export interface RequestOptions {
  readonly headers?: Readonly<Record<string, string | null>>;
  /** Sent verbatim when a string, JSON-encoded otherwise. */
  readonly body?: unknown;
}

/** The real app (`createApp`) with the crm write and privacy routes over the fake ports. */
export function buildCrmApp(
  options: { harness?: CommandHarness; principal?: StaffPrincipal | null } = {},
) {
  const harness = options.harness ?? createCommandHarness();
  const principal =
    options.principal === undefined ? aPrincipal(harness.clock.now()) : options.principal;
  const guards = new FakeStaffGuards(principal);
  const logLines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logLines.push(chunk.toString('utf8'));
      callback();
    },
  });
  const write = createCrmWriteRoutes({
    guards,
    changeLeadStage: harness.changeLeadStage,
    assignLeadOwner: harness.assignLeadOwner,
    addLeadNote: harness.addLeadNote,
    recordDenial: harness.recordDenial,
  });
  const dsr = createCrmDsrRoutes({
    guards,
    exportLeadsCsv: harness.exportLeadsCsv,
    exportLeadData: harness.exportLeadData,
    anonymizeLead: harness.anonymizeLead,
    recordDenial: harness.recordDenial,
    clock: harness.clock,
  });
  const app = createApp({
    config: loadConfig({ APP_ENV: 'development', CORS_ALLOWED_ORIGINS: 'https://crm.example.com' }),
    logger: createLogger({ level: 'debug', appEnv: 'test', destination }),
    // DSR first: `export.csv` must be matched before any `GET /v1/crm/leads/:id`.
    routes: [dsr as unknown as Hono<AppEnv>, write as unknown as Hono<AppEnv>],
  });

  const request = (method: string, path: string, req: RequestOptions = {}): Promise<Response> => {
    const headers = new Headers({
      'Content-Type': LEAD_JSON,
      Authorization: 'Bearer test-token',
    });
    for (const [name, value] of Object.entries(req.headers ?? {})) {
      if (value === null) {
        headers.delete(name);
      } else {
        headers.set(name, value);
      }
    }
    const hasBody = req.body !== undefined;
    return Promise.resolve(
      app.request(path, {
        method,
        headers,
        ...(hasBody
          ? { body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body) }
          : {}),
      }),
    );
  };

  /** Staff identity of the next requests; the clock of the harness is the reference "now". */
  const as = (role: StaffRole, extra: Omit<PrincipalOptions, 'role'> = {}): void => {
    guards.principal = aPrincipal(harness.clock.now(), { role, ...extra });
  };

  return { app, harness, guards, logLines, request, as };
}

export type CrmApp = ReturnType<typeof buildCrmApp>;

export async function problemOf(response: Response): Promise<{
  readonly status: number;
  readonly code: string;
  readonly errors?: readonly { field: string; code: string }[];
}> {
  return (await response.json()) as {
    status: number;
    code: string;
    errors?: { field: string; code: string }[];
  };
}
