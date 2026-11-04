import { Redis } from '@upstash/redis';
import type { Hono } from 'hono';
import type { Config } from '#/platform/config/env.ts';
import { createSupabaseAccessTokenVerifier } from '#/platform/auth/access-token-verifier.ts';
import type { StaffEnv, StaffGuards } from '#/platform/auth/staff.ts';
import { createStaffGuards } from '#/platform/auth/staff-guards.ts';
import { createPostgresStaffMembershipResolver } from '#/platform/auth/staff-membership.ts';
import {
  createUpstashStaffRateLimiter,
  createUpstashStaffWindowLimiters,
} from '#/platform/auth/staff-rate-limiter.ts';
import { createKeyedMac } from '#/platform/crypto/derived-key.ts';
import { createHmacHasher } from '#/platform/crypto/hashing.ts';
import {
  createPostgresAuditLogWriter,
  createPostgresUnitOfWork,
  type Sql,
} from '#/platform/db/index.ts';
import type { Logger } from '#/platform/logger/logger.ts';
import type { Metrics } from '#/platform/metrics/metrics.ts';
import { systemClock } from '#/platform/runtime/system-clock.ts';
import type { IdGenerator } from '#/shared/ids.ts';
import type { UnitOfWork } from '#/shared/unit-of-work.ts';
import { createAddLeadNote } from '#/modules/crm/application/commands/add-lead-note.ts';
import { createAnonymizeLead } from '#/modules/crm/application/commands/anonymize-lead.ts';
import { createAssignLeadOwner } from '#/modules/crm/application/commands/assign-lead-owner.ts';
import { createChangeLeadStage } from '#/modules/crm/application/commands/change-lead-stage.ts';
import type { MutationDependencies } from '#/modules/crm/application/commands/dependencies.ts';
import { createExportLeadData } from '#/modules/crm/application/commands/export-lead-data.ts';
import { createExportLeadsCsv } from '#/modules/crm/application/commands/export-leads-csv.ts';
import { createRecordDenial } from '#/modules/crm/application/commands/record-denial.ts';
import { createGetLeadDetail } from '#/modules/crm/application/queries/get-lead-detail.ts';
import {
  createListLeads,
  createSearchLeads,
} from '#/modules/crm/application/queries/list-leads.ts';
import {
  createGetStaffProfile,
  createListStaffMembers,
} from '#/modules/crm/application/staff-session.ts';
import { createHmacCursorCodec } from '#/modules/crm/infrastructure/hmac-cursor-codec.ts';
import { createPostgresAnonymizationGateway } from '#/modules/crm/infrastructure/postgres-anonymization-gateway.ts';
import { createPostgresLeadActivityRepository } from '#/modules/crm/infrastructure/postgres-lead-activity-repository.ts';
import { createPostgresLeadExportReader } from '#/modules/crm/infrastructure/postgres-lead-export-reader.ts';
import { createPostgresLeadNoteReader } from '#/modules/crm/infrastructure/postgres-lead-note-reader.ts';
import { createPostgresLeadQueries } from '#/modules/crm/infrastructure/postgres-lead-queries.ts';
import { createPostgresLeadReader } from '#/modules/crm/infrastructure/postgres-lead-reader.ts';
import { createPostgresLeadRepository } from '#/modules/crm/infrastructure/postgres-lead-repository.ts';
import { createPostgresMemberDirectory } from '#/modules/crm/infrastructure/postgres-member-directory.ts';
import { createPostgresStaffDirectory } from '#/modules/crm/infrastructure/postgres-staff-directory.ts';
import { createPostgresSubjectDataReader } from '#/modules/crm/infrastructure/postgres-subject-data-reader.ts';
import { createUpstashExportLock } from '#/modules/crm/infrastructure/upstash-export-lock.ts';
import { createUpstashStaffIdempotencyStore } from '#/modules/crm/infrastructure/upstash-staff-idempotency-store.ts';
import { createCrmDsrRoutes } from '#/modules/crm/presentation/dsr-routes.ts';
import { createCrmReadRoutes } from '#/modules/crm/presentation/read-routes.ts';
import { createCrmStaffRoutes } from '#/modules/crm/presentation/staff-routes.ts';
import { createCrmWriteRoutes } from '#/modules/crm/presentation/write-routes.ts';

/** One quick retry on network errors; the staff limiter already caps every Redis call at 1 s. */
const REDIS_RETRY = { retries: 1, backoff: () => REDIS_RETRY_BACKOFF_MS } as const;
const REDIS_RETRY_BACKOFF_MS = 50;

export interface CrmCompositionInput {
  readonly config: Config;
  /** Shared Postgres client; null when `DATABASE_URL` is not configured (development only). */
  readonly sql: Sql | null;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

interface CrmSecrets {
  readonly supabaseUrl: string;
  readonly upstashRedis: NonNullable<Config['upstashRedis']>;
  readonly hashPepper: string;
}

function crmSecrets(config: Config): CrmSecrets | null {
  const { supabase, upstashRedis, hashPepper } = config;
  if (supabase.url === undefined || upstashRedis === undefined || hashPepper === undefined) {
    return null;
  }
  return { supabaseUrl: supabase.url, upstashRedis, hashPepper };
}

/** Everything a CRM route group may need, built once per instance. */
export interface CrmWiring {
  readonly guards: StaffGuards;
  readonly unitOfWork: UnitOfWork;
  readonly sql: Sql;
  readonly redis: Redis;
  readonly hashPepper: string;
  readonly ids: IdGenerator;
  readonly logger: Logger;
}

/**
 * Wires `/v1/crm/*` (Onda 9b): Supabase access-token verification (JWKS), membership from
 * `core.workspace_members`, per-user Upstash limits, and the CRM route groups. Fails closed: with
 * any dependency missing no CRM route is mounted (the catch-all answers 404), never an
 * unauthenticated one.
 */
export function composeCrm(input: CrmCompositionInput): readonly Hono<StaffEnv>[] {
  const { config, logger, metrics, sql } = input;
  const secrets = crmSecrets(config);
  if (secrets === null || sql === null) {
    logger.warn({ route: '/v1/crm/*' }, 'crm api not configured; routes not mounted');
    return [];
  }

  const redis = new Redis({
    url: secrets.upstashRedis.url,
    token: secrets.upstashRedis.token,
    retry: REDIS_RETRY,
  });
  const guards = createStaffGuards({
    verifier: createSupabaseAccessTokenVerifier(secrets.supabaseUrl),
    memberships: createPostgresStaffMembershipResolver(sql),
    limiter: createUpstashStaffRateLimiter({
      windows: createUpstashStaffWindowLimiters(redis),
      clock: systemClock,
    }),
    metrics,
    hmac: createHmacHasher(secrets.hashPepper),
    trustVercelProxy: config.appEnv !== 'development',
  });
  const wiring: CrmWiring = {
    guards,
    unitOfWork: createPostgresUnitOfWork(sql),
    sql,
    redis,
    hashPepper: secrets.hashPepper,
    ids: input.ids,
    logger,
  };
  // DSR first: `GET /v1/crm/leads/export.csv` must win over `GET /v1/crm/leads/:id`.
  return [
    composeStaffRoutes(wiring),
    composeDsrRoutes(wiring),
    composeWriteRoutes(wiring),
    composeReadRoutes(wiring),
  ];
}

function composeStaffRoutes(wiring: CrmWiring): Hono<StaffEnv> {
  const directory = createPostgresStaffDirectory(wiring.unitOfWork);
  return createCrmStaffRoutes({
    guards: wiring.guards,
    getStaffProfile: createGetStaffProfile(directory),
    listStaffMembers: createListStaffMembers(directory),
  });
}

function composeReadRoutes(wiring: CrmWiring): Hono<StaffEnv> {
  const deps = {
    unitOfWork: wiring.unitOfWork,
    queries: createPostgresLeadQueries(),
    cursors: createHmacCursorCodec({
      mac: createKeyedMac(wiring.hashPepper, 'crm-cursor-v1'),
      clock: systemClock,
    }),
  };
  return createCrmReadRoutes({
    guards: wiring.guards,
    listLeads: createListLeads(deps),
    searchLeads: createSearchLeads(deps),
    getLeadDetail: createGetLeadDetail(deps),
  });
}

function composeWriteRoutes(wiring: CrmWiring): Hono<StaffEnv> {
  const mutation: MutationDependencies = {
    unitOfWork: wiring.unitOfWork,
    leads: createPostgresLeadReader(),
    leadWriter: createPostgresLeadRepository(),
    activities: createPostgresLeadActivityRepository(),
    audit: createPostgresAuditLogWriter(),
    idempotency: createUpstashStaffIdempotencyStore({ redis: wiring.redis, logger: wiring.logger }),
    clock: systemClock,
    ids: wiring.ids,
  };
  return createCrmWriteRoutes({
    guards: wiring.guards,
    // `stageOutbox` stays unset: tracking cannot dispatch `lead.stage_changed` yet (wave 11b).
    changeLeadStage: createChangeLeadStage(mutation),
    assignLeadOwner: createAssignLeadOwner({
      ...mutation,
      members: createPostgresMemberDirectory(),
    }),
    addLeadNote: createAddLeadNote({ ...mutation, notes: createPostgresLeadNoteReader() }),
    recordDenial: createRecordDenial({
      unitOfWork: wiring.unitOfWork,
      audit: createPostgresAuditLogWriter(),
      clock: systemClock,
    }),
  });
}

function composeDsrRoutes(wiring: CrmWiring): Hono<StaffEnv> {
  const audit = createPostgresAuditLogWriter();
  const leads = createPostgresLeadReader();
  return createCrmDsrRoutes({
    guards: wiring.guards,
    exportLeadsCsv: createExportLeadsCsv({
      unitOfWork: wiring.unitOfWork,
      reader: createPostgresLeadExportReader(),
      lock: createUpstashExportLock({ redis: wiring.redis, logger: wiring.logger }),
      audit,
      clock: systemClock,
      ids: wiring.ids,
    }),
    exportLeadData: createExportLeadData({
      unitOfWork: wiring.unitOfWork,
      leads,
      subjectData: createPostgresSubjectDataReader(),
      audit,
      clock: systemClock,
    }),
    anonymizeLead: createAnonymizeLead({
      unitOfWork: wiring.unitOfWork,
      leads,
      gateway: createPostgresAnonymizationGateway(),
      audit,
      idempotency: createUpstashStaffIdempotencyStore({
        redis: wiring.redis,
        logger: wiring.logger,
      }),
      planMac: createKeyedMac(wiring.hashPepper, 'crm-plan-v1'),
      clock: systemClock,
    }),
    recordDenial: createRecordDenial({ unitOfWork: wiring.unitOfWork, audit, clock: systemClock }),
    clock: systemClock,
  });
}
