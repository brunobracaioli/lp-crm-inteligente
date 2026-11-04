import { describe, expect, it } from 'vitest';
import { HttpProblem } from '#/platform/errors/problem.ts';
import type { StaffRole } from '#/platform/auth/staff.ts';
import {
  ADMIN_USER,
  KEY_1,
  KEY_2,
  OTHER_SALES_USER,
  SALES_USER,
  WORKSPACE_A,
  WORKSPACE_B,
  type CommandHarness,
} from '#test/fakes/crm-commands.ts';
import { ALL_ROLES, buildCrmApp, problemOf, UUID_PATTERN } from './crm-app.ts';
import type { LeadState } from '#/modules/crm/application/ports.ts';

type LeadShape = 'own' | 'other' | 'unowned';
const SHAPES: readonly LeadShape[] = ['own', 'other', 'unowned'];

/** Lead of workspace A shaped for `role`: owned by them, by a colleague, or by nobody. */
function seedFor(h: CommandHarness, role: StaffRole, shape: LeadShape): LeadState {
  const me = {
    owner: '00000000-0000-7000-8000-0000000000e1',
    admin: ADMIN_USER,
    sales: SALES_USER,
    viewer: '00000000-0000-7000-8000-0000000000e5',
  }[role];
  const ownerUserId = shape === 'own' ? me : shape === 'other' ? OTHER_SALES_USER : null;
  return h.seed(WORKSPACE_A, { ownerUserId: ownerUserId as LeadState['ownerUserId'] });
}

const stageBody = { to_stage: 'contacted', expected_version: 3 };

/** Expected status of each route for a role on a lead shape (threat model authz matrix, ST-10). */
function expected(route: 'stage' | 'owner' | 'notes', role: StaffRole, shape: LeadShape): number {
  if (role === 'viewer') return 403;
  if (route === 'owner') return role === 'sales' ? 403 : 200;
  if (role === 'sales' && shape === 'other') return 403;
  return route === 'notes' ? 201 : 200;
}

describe('PATCH /v1/crm/leads/{id}/stage', () => {
  it.each(ALL_ROLES.flatMap((role) => SHAPES.map((shape) => [role, shape] as const)))(
    'role %s on a lead that is %s',
    async (role, shape) => {
      const t = buildCrmApp();
      t.as(role);
      const lead = seedFor(t.harness, role, shape);

      const response = await t.request('PATCH', `/v1/crm/leads/${lead.id}/stage`, {
        body: stageBody,
      });

      expect(response.status).toBe(expected('stage', role, shape));
      if (response.status === 200) {
        const body = (await response.json()) as {
          stage: string;
          version: number;
          owner_user_id: string | null;
        };
        expect(body).toMatchObject({ stage: 'contacted', version: 4 });
        // G6: only sales takes ownership of an unowned lead
        expect(body.owner_user_id === SALES_USER && shape === 'unowned').toBe(
          role === 'sales' && shape === 'unowned',
        );
      } else {
        expect((await problemOf(response)).code).toBe('forbidden');
        expect(t.harness.leads.all()[0]).toMatchObject({ stage: 'new', version: 3 });
        // every refusal leaves exactly one denied audit row
        expect(t.harness.audit.entries).toHaveLength(1);
        expect(t.harness.audit.entries[0]).toMatchObject({
          action: 'lead.stage_changed',
          result: 'denied',
        });
      }
    },
  );

  it('answers 401 without credentials, even for an invalid body, and never reaches the use case', async () => {
    const t = buildCrmApp({ principal: null });
    const lead = t.harness.seed(WORKSPACE_A);

    const response = await t.request('PATCH', `/v1/crm/leads/${lead.id}/stage`, { body: '{bad' });

    expect(response.status).toBe(401);
    expect(t.harness.audit.entries).toHaveLength(0);
    expect(t.guards.limiterCalls).toHaveLength(0);
  });

  it('rate limits in the write bucket, fail-open', async () => {
    const t = buildCrmApp();
    const lead = t.harness.seed(WORKSPACE_A);

    await t.request('PATCH', `/v1/crm/leads/${lead.id}/stage`, { body: stageBody });

    expect(t.guards.limiterCalls).toEqual([{ bucket: 'write', fail: 'open' }]);
  });

  it('returns the limiter 429 with Retry-After before any role or lead check', async () => {
    const t = buildCrmApp();
    t.guards.limiterProblem = new HttpProblem(429, 'rate_limited', { retryAfterSeconds: 30 });
    t.as('viewer');

    const response = await t.request('PATCH', `/v1/crm/leads/${WORKSPACE_A}/stage`, {
      body: stageBody,
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(t.harness.audit.entries).toHaveLength(0);
  });

  describe('order of evaluation', () => {
    it('role (403) comes before the id (400)', async () => {
      const t = buildCrmApp();
      t.as('viewer');
      const response = await t.request('PATCH', '/v1/crm/leads/not-a-uuid/stage', {
        body: stageBody,
      });
      expect(response.status).toBe(403);
      // the denial is audited even though the id is not a UUID (nil resource id)
      expect(t.harness.audit.entries[0]?.resourceId).toBe('00000000-0000-0000-0000-000000000000');
    });

    it('id (400) comes before the lead (404)', async () => {
      const t = buildCrmApp();
      const response = await t.request('PATCH', '/v1/crm/leads/not-a-uuid/stage', {
        body: stageBody,
      });
      expect(response.status).toBe(400);
      expect(await problemOf(response)).toMatchObject({
        code: 'validation_failed',
        errors: [{ field: 'id', code: 'invalid_format' }],
      });
    });

    it('lead of another workspace (404) comes before the body (400) — AC-CRM-06 / ST-13', async () => {
      const t = buildCrmApp();
      const foreign = t.harness.seed(WORKSPACE_B);
      const malformed = await t.request('PATCH', `/v1/crm/leads/${foreign.id}/stage`, {
        body: '{bad',
      });
      const invalid = await t.request('PATCH', `/v1/crm/leads/${foreign.id}/stage`, {
        body: { to_stage: 'x' },
      });
      const unknown = await t.request('PATCH', `/v1/crm/leads/${WORKSPACE_A}/stage`, {
        body: stageBody,
      });

      expect(malformed.status).toBe(404);
      expect(invalid.status).toBe(404);
      expect(await problemOf(unknown)).toMatchObject({ status: 404, code: 'not_found' });
    });

    it('the per-resource rule (403) comes before the body (400)', async () => {
      const t = buildCrmApp();
      t.as('sales');
      const lead = t.harness.seed(WORKSPACE_A, { ownerUserId: OTHER_SALES_USER });

      const response = await t.request('PATCH', `/v1/crm/leads/${lead.id}/stage`, {
        body: { bogus: 1 },
      });

      expect(response.status).toBe(403);
    });

    it('the body (400) comes before the business rules (409/422)', async () => {
      const t = buildCrmApp();
      const lead = t.harness.seed(WORKSPACE_A);
      const response = await t.request('PATCH', `/v1/crm/leads/${lead.id}/stage`, {
        body: { to_stage: 'lost', expected_version: 1 },
      });
      expect(response.status).toBe(400);
      expect(await problemOf(response)).toMatchObject({
        errors: [{ field: 'lost_reason', code: 'required' }],
      });
    });
  });

  describe('status mapping', () => {
    it('409 version_conflict and nothing changes (AC-CRM-08)', async () => {
      const t = buildCrmApp();
      const lead = t.harness.seed(WORKSPACE_A);

      const response = await t.request('PATCH', `/v1/crm/leads/${lead.id}/stage`, {
        body: { to_stage: 'contacted', expected_version: 2 },
      });

      expect(response.status).toBe(409);
      expect((await problemOf(response)).code).toBe('version_conflict');
      expect(t.harness.leads.all()[0]).toMatchObject({ stage: 'new', version: 3 });
      expect(t.harness.activities.records).toHaveLength(0);
    });

    it('422 invalid_stage_transition', async () => {
      const t = buildCrmApp();
      const lead = t.harness.seed(WORKSPACE_A);
      const response = await t.request('PATCH', `/v1/crm/leads/${lead.id}/stage`, {
        body: { to_stage: 'won', expected_version: 3 },
      });
      expect(response.status).toBe(422);
      expect((await problemOf(response)).code).toBe('invalid_stage_transition');
    });

    it('409 lead_anonymized', async () => {
      const t = buildCrmApp();
      const lead = t.harness.seed(WORKSPACE_A, { anonymizedAt: new Date('2026-11-04T00:00:00Z') });
      const response = await t.request('PATCH', `/v1/crm/leads/${lead.id}/stage`, {
        body: stageBody,
      });
      expect(response.status).toBe(409);
      expect((await problemOf(response)).code).toBe('lead_anonymized');
    });

    it('415 for a non-JSON media type and 400 invalid_json for malformed JSON', async () => {
      const t = buildCrmApp();
      const lead = t.harness.seed(WORKSPACE_A);
      const wrongType = await t.request('PATCH', `/v1/crm/leads/${lead.id}/stage`, {
        headers: { 'Content-Type': 'text/plain' },
        body: 'x',
      });
      const malformed = await t.request('PATCH', `/v1/crm/leads/${lead.id}/stage`, {
        body: '{bad',
      });
      expect(wrongType.status).toBe(415);
      expect(malformed.status).toBe(400);
      expect((await problemOf(malformed)).code).toBe('invalid_json');
    });

    it('413 for a body over 16 KB', async () => {
      const t = buildCrmApp();
      const lead = t.harness.seed(WORKSPACE_A);
      const response = await t.request('PATCH', `/v1/crm/leads/${lead.id}/stage`, {
        body: 'x'.repeat(16 * 1024 + 1),
      });
      expect(response.status).toBe(413);
    });

    it('mass assignment: workspace_id, role and owner_user_id are 400', async () => {
      const t = buildCrmApp();
      const lead = t.harness.seed(WORKSPACE_A);
      const response = await t.request('PATCH', `/v1/crm/leads/${lead.id}/stage`, {
        body: { ...stageBody, workspace_id: WORKSPACE_B, role: 'owner', owner_user_id: SALES_USER },
      });
      expect(response.status).toBe(400);
      expect((await problemOf(response)).errors?.map((e) => e.field).sort()).toEqual([
        'owner_user_id',
        'role',
        'workspace_id',
      ]);
    });

    it('a malformed Idempotency-Key is 400 validation_failed', async () => {
      const t = buildCrmApp();
      const lead = t.harness.seed(WORKSPACE_A);
      const response = await t.request('PATCH', `/v1/crm/leads/${lead.id}/stage`, {
        headers: { 'Idempotency-Key': 'nope' },
        body: stageBody,
      });
      expect(response.status).toBe(400);
    });

    it('replays an Idempotency-Key: same 200, one timeline row', async () => {
      const t = buildCrmApp();
      const lead = t.harness.seed(WORKSPACE_A);
      const send = () =>
        t.request('PATCH', `/v1/crm/leads/${lead.id}/stage`, {
          headers: { 'Idempotency-Key': KEY_1 },
          body: stageBody,
        });

      const first = await send();
      const second = await send();

      expect(first.status).toBe(200);
      expect(await second.json()).toEqual(await first.json());
      expect(t.harness.activities.records).toHaveLength(1);
    });

    it('answers 422 idempotency_key_reused for the same key with another body', async () => {
      const t = buildCrmApp();
      const lead = t.harness.seed(WORKSPACE_A);
      await t.request('PATCH', `/v1/crm/leads/${lead.id}/stage`, {
        headers: { 'Idempotency-Key': KEY_1 },
        body: stageBody,
      });
      const response = await t.request('PATCH', `/v1/crm/leads/${lead.id}/stage`, {
        headers: { 'Idempotency-Key': KEY_1 },
        body: { to_stage: 'qualified', expected_version: 4 },
      });
      expect(response.status).toBe(422);
      expect((await problemOf(response)).code).toBe('idempotency_key_reused');
    });
  });

  it('echoes the correlation id and carries the security headers and no-store', async () => {
    const t = buildCrmApp();
    const lead = t.harness.seed(WORKSPACE_A);
    const response = await t.request('PATCH', `/v1/crm/leads/${lead.id}/stage`, {
      body: stageBody,
    });
    expect(response.headers.get('X-Request-Id')).toMatch(UUID_PATTERN);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('keeps PII out of the request log', async () => {
    const t = buildCrmApp();
    const lead = t.harness.seed(WORKSPACE_A);
    await t.request('PATCH', `/v1/crm/leads/${lead.id}/stage`, { body: stageBody });
    expect(t.logLines.join('')).not.toMatch(/maria|empresa|bearer|test-token/i);
  });
});

describe('PATCH /v1/crm/leads/{id}/owner', () => {
  it.each(ALL_ROLES.flatMap((role) => SHAPES.map((shape) => [role, shape] as const)))(
    'role %s on a lead that is %s',
    async (role, shape) => {
      const t = buildCrmApp();
      t.as(role);
      const lead = seedFor(t.harness, role, shape);

      const response = await t.request('PATCH', `/v1/crm/leads/${lead.id}/owner`, {
        body: { owner_user_id: SALES_USER, expected_version: 3 },
      });

      expect(response.status).toBe(expected('owner', role, shape));
      if (response.status === 403) {
        expect(t.harness.leads.all()[0]?.version).toBe(3);
        expect(t.harness.audit.entries[0]).toMatchObject({
          action: 'lead.owner_assigned',
          result: 'denied',
        });
      }
    },
  );

  it('uses the write bucket, fail-open', async () => {
    const t = buildCrmApp();
    const lead = t.harness.seed(WORKSPACE_A);
    await t.request('PATCH', `/v1/crm/leads/${lead.id}/owner`, {
      body: { owner_user_id: null, expected_version: 3 },
    });
    expect(t.guards.limiterCalls).toEqual([{ bucket: 'write', fail: 'open' }]);
  });

  it('400 for a target that is not an active member of the workspace (C19)', async () => {
    const t = buildCrmApp();
    const lead = t.harness.seed(WORKSPACE_A);
    const response = await t.request('PATCH', `/v1/crm/leads/${lead.id}/owner`, {
      body: { owner_user_id: '00000000-0000-7000-8000-0000000000ff', expected_version: 3 },
    });
    expect(response.status).toBe(400);
    expect(await problemOf(response)).toMatchObject({
      errors: [{ field: 'owner_user_id', code: 'invalid_choice' }],
    });
  });

  it('404 for another workspace and 409 for a stale version', async () => {
    const t = buildCrmApp();
    const foreign = t.harness.seed(WORKSPACE_B);
    const lead = t.harness.seed(WORKSPACE_A);
    const notFound = await t.request('PATCH', `/v1/crm/leads/${foreign.id}/owner`, {
      body: { owner_user_id: null, expected_version: 3 },
    });
    const stale = await t.request('PATCH', `/v1/crm/leads/${lead.id}/owner`, {
      body: { owner_user_id: null, expected_version: 1 },
    });
    expect(notFound.status).toBe(404);
    expect(stale.status).toBe(409);
    expect((await problemOf(stale)).code).toBe('version_conflict');
  });

  it('answers 401 without credentials', async () => {
    const t = buildCrmApp({ principal: null });
    const response = await t.request('PATCH', `/v1/crm/leads/${WORKSPACE_A}/owner`, { body: {} });
    expect(response.status).toBe(401);
  });
});

describe('POST /v1/crm/leads/{id}/notes', () => {
  it.each(ALL_ROLES.flatMap((role) => SHAPES.map((shape) => [role, shape] as const)))(
    'role %s on a lead that is %s',
    async (role, shape) => {
      const t = buildCrmApp();
      t.as(role);
      const lead = seedFor(t.harness, role, shape);

      const response = await t.request('POST', `/v1/crm/leads/${lead.id}/notes`, {
        headers: { 'Idempotency-Key': KEY_1 },
        body: { body: 'Ligar amanhã' },
      });

      expect(response.status).toBe(expected('notes', role, shape));
      if (response.status === 201) {
        expect(await response.json()).toMatchObject({
          type: 'note_added',
          actor_type: 'user',
          data: { body: 'Ligar amanhã' },
        });
        // a note never assigns the lead
        expect(t.harness.leads.all()[0]?.ownerUserId ?? null).toBe(lead.ownerUserId);
      } else {
        expect(t.harness.activities.records).toHaveLength(0);
        expect(t.harness.audit.entries[0]).toMatchObject({
          action: 'lead.note_added',
          result: 'denied',
        });
      }
    },
  );

  it('400 idempotency_key_missing without the header', async () => {
    const t = buildCrmApp();
    const lead = t.harness.seed(WORKSPACE_A);
    const response = await t.request('POST', `/v1/crm/leads/${lead.id}/notes`, {
      body: { body: 'x' },
    });
    expect(response.status).toBe(400);
    expect((await problemOf(response)).code).toBe('idempotency_key_missing');
  });

  it('replays 201 with the same note for the same key; 422 for another text', async () => {
    const t = buildCrmApp();
    const lead = t.harness.seed(WORKSPACE_A);
    const send = (text: string, key = KEY_1) =>
      t.request('POST', `/v1/crm/leads/${lead.id}/notes`, {
        headers: { 'Idempotency-Key': key },
        body: { body: text },
      });

    const first = await send('olá');
    const second = await send('olá');
    const reused = await send('outro');
    const next = await send('outro', KEY_2);

    expect(first.status).toBe(201);
    expect(await second.json()).toEqual(await first.json());
    expect(reused.status).toBe(422);
    expect(next.status).toBe(201);
    expect(t.harness.activities.records).toHaveLength(2);
  });

  it('400 not_allowed_characters for a bidi override; script tags are stored literally (ST-39)', async () => {
    const t = buildCrmApp();
    const lead = t.harness.seed(WORKSPACE_A);
    const bad = await t.request('POST', `/v1/crm/leads/${lead.id}/notes`, {
      headers: { 'Idempotency-Key': KEY_1 },
      body: { body: 'a‮b' },
    });
    const markup = await t.request('POST', `/v1/crm/leads/${lead.id}/notes`, {
      headers: { 'Idempotency-Key': KEY_2 },
      body: { body: '<script>alert(1)</script>' },
    });

    expect(bad.status).toBe(400);
    expect((await problemOf(bad)).errors).toEqual([
      { field: 'body', code: 'not_allowed_characters' },
    ]);
    expect(markup.status).toBe(201);
    expect(markup.headers.get('Content-Type')).toContain('application/json');
    expect(((await markup.json()) as { data: { body: string } }).data.body).toBe(
      '<script>alert(1)</script>',
    );
  });

  it('503 when the idempotency store is down (a retry could duplicate)', async () => {
    const t = buildCrmApp();
    t.harness.idempotency.unavailable = true;
    const lead = t.harness.seed(WORKSPACE_A);
    const response = await t.request('POST', `/v1/crm/leads/${lead.id}/notes`, {
      headers: { 'Idempotency-Key': KEY_1 },
      body: { body: 'x' },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    expect(t.harness.activities.records).toHaveLength(0);
  });

  it('keeps the note text out of logs and audit', async () => {
    const t = buildCrmApp();
    const lead = t.harness.seed(WORKSPACE_A);
    await t.request('POST', `/v1/crm/leads/${lead.id}/notes`, {
      headers: { 'Idempotency-Key': KEY_1 },
      body: { body: 'segredo-da-negociacao' },
    });
    expect(t.logLines.join('')).not.toContain('segredo-da-negociacao');
    expect(JSON.stringify(t.harness.audit.entries)).not.toContain('segredo-da-negociacao');
  });

  it('404 for another workspace (AC-CRM-06)', async () => {
    const t = buildCrmApp();
    const foreign = t.harness.seed(WORKSPACE_B);
    const response = await t.request('POST', `/v1/crm/leads/${foreign.id}/notes`, {
      headers: { 'Idempotency-Key': KEY_1 },
      body: { body: 'x' },
    });
    expect(response.status).toBe(404);
  });
});
