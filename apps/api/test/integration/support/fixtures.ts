import type { Sql } from '#/platform/db/client.ts';
import type { FormId, IdGenerator, LeadId, WorkspaceId } from '#/shared/ids.ts';
import type { LeadState } from '#/modules/crm/application/ports.ts';
import { purgeWorkspaces } from './database.ts';

export const FIXTURE_ORIGIN = 'https://www.dominio.com.br';
export const FIXTURE_POLICY_VERSION = '2026-11-03';
const RANDOM_SUFFIX_LENGTH = 12;

export interface WorkspaceFixture {
  readonly workspaceId: WorkspaceId;
  readonly formId: FormId;
  readonly formKey: string;
}

export interface WorkspaceFixtureOptions {
  /** Raw `settings.icp` JSON (snake_case); omitted = no ICP configured. */
  readonly icp?: Readonly<Record<string, readonly string[]>>;
  readonly formStatus?: 'active' | 'paused' | 'archived';
}

/**
 * Creates and tracks throwaway workspaces through the admin connection. Each test owns its own
 * workspace(s), so tests never share rows; `dispose()` removes what they created.
 */
export class FixtureScope {
  readonly #admin: Sql;
  readonly #ids: IdGenerator;
  readonly #workspaceIds: string[] = [];

  constructor(admin: Sql, ids: IdGenerator) {
    this.#admin = admin;
    this.#ids = ids;
  }

  async workspace(options: WorkspaceFixtureOptions = {}): Promise<WorkspaceFixture> {
    const workspaceId = this.#ids.uuidv7() as WorkspaceId;
    const formId = this.#ids.uuidv7() as FormId;
    const suffix = workspaceId.replaceAll('-', '').slice(-RANDOM_SUFFIX_LENGTH);
    const formKey = `frm_t${suffix}`;
    const settings = options.icp === undefined ? {} : { icp: options.icp };
    const admin = this.#admin;
    await admin`
      INSERT INTO core.workspaces (id, slug, name, settings)
      VALUES (${workspaceId}, ${`t-${suffix}`}, ${'Integration test workspace'}, ${admin.json(settings)})
    `;
    await admin`
      INSERT INTO core.forms (
        id, workspace_id, form_key, name, status, allowed_origins, turnstile_action, privacy_policy_version
      ) VALUES (
        ${formId}, ${workspaceId}, ${formKey}, ${'Integration test form'}, ${options.formStatus ?? 'active'},
        ARRAY[${FIXTURE_ORIGIN}]::text[], 'lead_submit', ${FIXTURE_POLICY_VERSION}
      )
    `;
    this.#workspaceIds.push(workspaceId);
    return { workspaceId, formId, formKey };
  }

  async dispose(): Promise<void> {
    const created = this.#workspaceIds.splice(0);
    await purgeWorkspaces(this.#admin, created);
  }
}

export interface RowCounts {
  readonly leads: number;
  readonly submissions: number;
  readonly consents: number;
  readonly activities: number;
  readonly outbox: number;
  readonly audit: number;
}

/** Rows of one workspace across every table SubmitLead writes (admin connection, RLS bypassed). */
export async function countRows(admin: Sql, workspaceId: WorkspaceId): Promise<RowCounts> {
  const rows = await admin<RowCounts[]>`
    SELECT
      (SELECT count(*)::int FROM crm.leads WHERE workspace_id = ${workspaceId}) AS leads,
      (SELECT count(*)::int FROM capture.submissions WHERE workspace_id = ${workspaceId}) AS submissions,
      (SELECT count(*)::int FROM capture.consents WHERE workspace_id = ${workspaceId}) AS consents,
      (SELECT count(*)::int FROM crm.lead_activities WHERE workspace_id = ${workspaceId}) AS activities,
      (SELECT count(*)::int FROM tracking.outbox_events WHERE workspace_id = ${workspaceId}) AS outbox,
      (SELECT count(*)::int FROM core.audit_log WHERE workspace_id = ${workspaceId}) AS audit
  `;
  const counts = rows[0];
  if (counts === undefined) {
    throw new Error('count query returned no row');
  }
  return counts;
}

export const NO_ROWS: RowCounts = {
  leads: 0,
  submissions: 0,
  consents: 0,
  activities: 0,
  outbox: 0,
  audit: 0,
};

const NOW = new Date('2026-11-03T12:00:00.000Z');

/** A complete persisted lead; `overrides` replace fields. IDs and e-mail are unique per call. */
export function aLeadState(
  workspaceId: WorkspaceId,
  ids: IdGenerator,
  overrides: Partial<LeadState> = {},
): LeadState {
  const id = ids.uuidv7() as LeadId;
  return {
    id,
    workspaceId,
    firstName: 'Maria',
    lastName: 'Silva',
    email: `lead-${id.slice(-12)}@empresa.com.br`,
    whatsappE164: '+5511912345678',
    companyName: 'Empresa Ltda',
    areaOfExpertise: 'technology',
    areaOfExpertiseOther: null,
    jobTitle: 'Head de Marketing',
    companySize: '11_50',
    companyWebsite: 'https://empresa.com.br',
    stage: 'new',
    lostReason: null,
    score: 42,
    scoreBand: 'B',
    scoreBreakdown: [
      { ruleId: 'fit_segment', points: 15 },
      { ruleId: 'intent_whatsapp', points: 27 },
    ],
    ownerUserId: null,
    marketingOptIn: true,
    submissionsCount: 1,
    firstTouch: {
      utmSource: 'meta',
      utmMedium: null,
      utmCampaign: null,
      utmTerm: null,
      utmContent: null,
      utmId: null,
      gclid: null,
      gbraid: null,
      wbraid: null,
      fbclid: 'IwAR123',
      ttclid: null,
      msclkid: null,
      fbp: null,
      fbc: null,
      gaClientId: null,
      landingPageUrl: `${FIXTURE_ORIGIN}/?utm_source=meta`,
      referrerUrl: null,
    },
    lastTouch: {
      utmSource: 'meta',
      utmMedium: null,
      utmCampaign: null,
      utmTerm: null,
      utmContent: null,
      utmId: null,
      gclid: null,
      gbraid: null,
      wbraid: null,
      fbclid: 'IwAR123',
      ttclid: null,
      msclkid: null,
      fbp: null,
      fbc: null,
      gaClientId: null,
      landingPageUrl: `${FIXTURE_ORIGIN}/?utm_source=meta`,
      referrerUrl: null,
    },
    firstSubmittedAt: NOW,
    lastSubmittedAt: NOW,
    anonymizedAt: null,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}
