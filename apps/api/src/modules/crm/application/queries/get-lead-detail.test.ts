import { beforeEach, describe, expect, it } from 'vitest';
import type { LeadId } from '#/shared/ids.ts';
import type { ActivityView, SubmissionView } from '#/modules/crm/application/queries/ports.ts';
import { FakeClock } from '#test/fakes/clock.ts';
import {
  InMemoryLeadQueries,
  NO_TOUCH,
  OTHER_USER,
  USER_A,
  WORKSPACE_A,
  WORKSPACE_B,
  aCursorCodec,
  aFakeUnitOfWork,
  aProfile,
} from '#test/fakes/crm-read.ts';
import { createGetLeadDetail, type GetLeadDetailInput } from './get-lead-detail.ts';

const T0 = new Date('2026-11-03T14:00:00.000Z');
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);
const uuid = (prefix: string, n: number): string =>
  `0194f1c2-${prefix}-7000-8000-${n.toString().padStart(12, '0')}`;
const LEAD_ID = uuid('aaaa', 1) as LeadId;
const OTHER_LEAD_ID = uuid('aaaa', 2) as LeadId;

function activity(n: number, createdAt: Date): ActivityView {
  return {
    id: uuid('bbbb', n),
    type: 'note_added',
    actorType: 'user',
    actorId: USER_A,
    createdAt,
    data: { body: `note ${String(n)}` },
  };
}

function submission(n: number): SubmissionView {
  return {
    id: uuid('cccc', n),
    createdAt: at(-n),
    fields: {
      firstName: 'Carla',
      lastName: 'Menezes',
      email: 'carla@acme.com.br',
      whatsapp: '+5511912345678',
      company: 'Acme',
      areaOfExpertise: 'technology',
      areaOfExpertiseOther: null,
      jobTitle: null,
      companySize: null,
      companyWebsite: null,
      marketingOptIn: true,
    },
    message: null,
    attribution: NO_TOUCH,
    consentState: {
      analyticsStorage: 'granted',
      adStorage: 'denied',
      adUserData: 'denied',
      adPersonalization: 'denied',
    },
  };
}

let queries: InMemoryLeadQueries;
let clock: FakeClock;
let unitOfWork: ReturnType<typeof aFakeUnitOfWork>;

function build() {
  const deps = { unitOfWork, queries, cursors: aCursorCodec(clock) };
  return createGetLeadDetail(deps);
}

function input(overrides: Partial<GetLeadDetailInput> = {}): GetLeadDetailInput {
  return {
    workspaceId: WORKSPACE_A,
    userId: USER_A,
    leadId: LEAD_ID,
    activitiesLimit: 2,
    activitiesCursor: null,
    ...overrides,
  };
}

beforeEach(() => {
  clock = new FakeClock();
  unitOfWork = aFakeUnitOfWork();
  queries = new InMemoryLeadQueries();
  queries.addLead(WORKSPACE_A, aProfile(LEAD_ID, at(0), { submissionsCount: 3 }), {
    submissions: [submission(1), submission(2), submission(3)],
    consents: [
      { purpose: 'privacy_policy', granted: true, policyVersion: '2026-11-03', recordedAt: at(0) },
    ],
    activities: [1, 2, 3, 4, 5].map((n) => activity(n, at(n))),
  });
  queries.addLead(WORKSPACE_A, aProfile(OTHER_LEAD_ID, at(1)), {
    activities: [activity(50, at(50))],
  });
  queries.addLead(WORKSPACE_B, aProfile(uuid('dddd', 1), at(2)));
});

describe('getLeadDetail', () => {
  it('assembles the lead, submissions, consents and the first page of activities', async () => {
    const result = await build()(input());

    if (!result.ok) throw new Error('unexpected failure');
    expect(result.value.lead.id).toBe(LEAD_ID);
    expect(result.value.submissions).toHaveLength(3);
    expect(result.value.consents).toHaveLength(1);
    expect(result.value.activities.items.map((a) => a.id)).toEqual([
      uuid('bbbb', 5),
      uuid('bbbb', 4),
    ]);
    expect(result.value.activities.nextCursor).not.toBeNull();
    expect(unitOfWork.scopes).toEqual([WORKSPACE_A]);
  });

  it('pages the timeline newest first until the cursor is null, without repeats', async () => {
    const detail = build();
    const seen: string[] = [];

    let cursor: string | null = null;
    for (let pages = 0; pages < 10; pages += 1) {
      const result = await detail(input({ activitiesCursor: cursor }));
      if (!result.ok) throw new Error('unexpected failure');
      seen.push(...result.value.activities.items.map((a) => a.id));
      cursor = result.value.activities.nextCursor;
      if (cursor === null) break;
    }

    expect(seen).toEqual([5, 4, 3, 2, 1].map((n) => uuid('bbbb', n)));
  });

  it('answers not_found for a lead of another workspace and for a nonexistent one alike', async () => {
    const detail = build();

    const foreign = await detail(input({ leadId: uuid('dddd', 1) as LeadId }));
    const missing = await detail(input({ leadId: uuid('eeee', 1) as LeadId }));

    expect(foreign).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(missing).toEqual(foreign);
  });

  it('never reads activities, submissions or consents of a lead it could not find', async () => {
    await build()(input({ leadId: uuid('dddd', 1) as LeadId }));

    expect(queries.calls.map((call) => call.method)).toEqual(['findLeadProfile']);
  });

  it('rejects an activities cursor minted for another lead, user, or expired', async () => {
    const detail = build();
    const first = await detail(input());
    if (!first.ok || first.value.activities.nextCursor === null) throw new Error('need a cursor');
    const cursor = first.value.activities.nextCursor;

    const otherLead = await detail(input({ leadId: OTHER_LEAD_ID, activitiesCursor: cursor }));
    const otherUser = await detail(input({ userId: OTHER_USER, activitiesCursor: cursor }));
    clock.advance(2 * 60 * 60 * 1000);
    const expired = await detail(input({ activitiesCursor: cursor }));

    for (const result of [otherLead, otherUser, expired]) {
      expect(result).toEqual({ ok: false, error: { code: 'invalid_cursor' } });
    }
  });

  it('reads at most 50 submissions', async () => {
    const many = Array.from({ length: 60 }, (_, n) => submission(n + 1));
    const leadId = uuid('ffff', 1) as LeadId;
    queries.addLead(WORKSPACE_A, aProfile(leadId, at(3)), { submissions: many });

    const result = await build()(input({ leadId }));

    expect(result.ok && result.value.submissions).toHaveLength(50);
  });
});
