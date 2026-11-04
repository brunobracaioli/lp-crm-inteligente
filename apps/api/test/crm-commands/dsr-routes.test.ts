import { describe, expect, it } from 'vitest';
import { DependencyUnavailableError } from '#/platform/errors/dependency-unavailable.ts';
import { HttpProblem } from '#/platform/errors/problem.ts';
import type { StaffRole } from '#/platform/auth/staff.ts';
import { KEY_1, WORKSPACE_A, WORKSPACE_B } from '#test/fakes/crm-commands.ts';
import { ALL_ROLES, buildCrmApp, problemOf, type CrmApp } from './crm-app.ts';

const PRIVILEGED: readonly StaffRole[] = ['owner', 'admin'];
const UNPRIVILEGED: readonly StaffRole[] = ['sales', 'viewer'];
const STALE_MFA_SECONDS = 301;

type Mfa = 'aal2-fresh' | 'aal2-stale' | 'aal1';

function withMfa(t: CrmApp, role: StaffRole, mfa: Mfa): void {
  if (mfa === 'aal1') t.as(role, { aal: 'aal1', mfaAgeSeconds: null });
  else if (mfa === 'aal2-stale') t.as(role, { mfaAgeSeconds: STALE_MFA_SECONDS });
  else t.as(role, { mfaAgeSeconds: 60 });
}

const MFA_STATES: readonly Mfa[] = ['aal2-fresh', 'aal2-stale', 'aal1'];

describe('GET /v1/crm/leads/export.csv', () => {
  const EXPORT = '/v1/crm/leads/export.csv';

  it.each(ALL_ROLES.flatMap((role) => MFA_STATES.map((mfa) => [role, mfa] as const)))(
    'role %s with %s',
    async (role, mfa) => {
      const t = buildCrmApp();
      withMfa(t, role, mfa);
      t.harness.seed(WORKSPACE_A);

      const response = await t.request('GET', EXPORT);

      if (UNPRIVILEGED.includes(role)) {
        // the role is checked before MFA: no MFA hint for someone who cannot export (C13)
        expect(response.status).toBe(403);
        expect((await problemOf(response)).code).toBe('forbidden');
      } else if (mfa === 'aal1') {
        expect(response.status).toBe(403);
        expect((await problemOf(response)).code).toBe('mfa_required');
      } else if (mfa === 'aal2-stale') {
        expect(response.status).toBe(403);
        expect((await problemOf(response)).code).toBe('reauthentication_required');
      } else {
        expect(response.status).toBe(200);
      }
      if (response.status === 403) {
        expect(t.harness.exportLock.acquired).toBe(0);
        expect(t.harness.audit.entries).toEqual([
          expect.objectContaining({
            action: 'lead.exported',
            result: 'denied',
            resourceType: 'lead_export',
            actorId: t.guards.principal?.userId,
          }),
        ]);
      }
    },
  );

  it('exports the CSV with the contract headers and neutralized cells (AC-CRM-07)', async () => {
    const t = buildCrmApp();
    t.harness.seed(WORKSPACE_A, { firstName: '=1+1' });

    const response = await t.request('GET', EXPORT);
    const bytes = new Uint8Array(await response.clone().arrayBuffer());
    const csv = await response.text(); // text() decoding drops the BOM

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="leads-20261103.csv"',
    );
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Export-Row-Count')).toBe('1');
    expect(response.headers.get('X-Export-Truncated')).toBe('false');
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(csv.startsWith('lead_id,created_at,first_name')).toBe(true);
    expect(csv).toContain(",'=1+1,");
    expect(t.harness.audit.entries[0]).toMatchObject({
      action: 'lead.exported',
      result: 'success',
    });
  });

  it('takes the export bucket, fail-closed', async () => {
    const t = buildCrmApp();
    await t.request('GET', EXPORT);
    expect(t.guards.limiterCalls).toEqual([{ bucket: 'export', fail: 'closed' }]);
  });

  it('503 when the limiter cannot decide on a fail-closed route; nothing is exported', async () => {
    const t = buildCrmApp();
    t.guards.limiterProblem = new HttpProblem(503, 'service_unavailable', { retryAfterSeconds: 5 });
    const response = await t.request('GET', EXPORT);
    expect(response.status).toBe(503);
    expect(t.harness.audit.entries).toHaveLength(0);
  });

  it('429 with Retry-After for a second simultaneous export; the lock is released afterwards', async () => {
    const t = buildCrmApp();
    const held = await t.harness.exportLock.acquire(WORKSPACE_A, t.guards.principal!.userId);

    const blocked = await t.request('GET', EXPORT);
    await held?.release();
    const allowed = await t.request('GET', EXPORT);

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('10');
    expect((await problemOf(blocked)).code).toBe('rate_limited');
    expect(allowed.status).toBe(200);
  });

  it('503 when the lock backend is down (fail-closed)', async () => {
    const t = buildCrmApp();
    t.harness.exportLock.failure = new DependencyUnavailableError('cache');
    const response = await t.request('GET', EXPORT);
    expect(response.status).toBe(503);
  });

  it('rejects unknown and repeated query parameters with 400 (no PII in a query string)', async () => {
    const t = buildCrmApp();
    const unknown = await t.request('GET', `${EXPORT}?email=maria@empresa.com.br`);
    const repeated = await t.request('GET', `${EXPORT}?stage=new&stage=won`);
    const invalid = await t.request('GET', `${EXPORT}?score_band=Z`);
    expect([unknown.status, repeated.status, invalid.status]).toEqual([400, 400, 400]);
  });

  it('applies the filters and only exports the workspace of the credential', async () => {
    const t = buildCrmApp();
    t.harness.seed(WORKSPACE_A, { stage: 'won', scoreBand: 'A' });
    t.harness.seed(WORKSPACE_A, { stage: 'new', scoreBand: 'A' });
    t.harness.seed(WORKSPACE_B, { stage: 'won', scoreBand: 'A' });

    const response = await t.request('GET', `${EXPORT}?stage=won&score_band=A`);

    expect(response.headers.get('X-Export-Row-Count')).toBe('1');
  });

  it('answers 401 without credentials', async () => {
    const t = buildCrmApp({ principal: null });
    expect((await t.request('GET', EXPORT)).status).toBe(401);
  });
});

describe('GET /v1/crm/leads/{id}/data-export', () => {
  const path = (id: string) => `/v1/crm/leads/${id}/data-export`;

  it.each(ALL_ROLES.flatMap((role) => MFA_STATES.map((mfa) => [role, mfa] as const)))(
    'role %s with %s',
    async (role, mfa) => {
      const t = buildCrmApp();
      withMfa(t, role, mfa);
      const lead = t.harness.seed(WORKSPACE_A);

      const response = await t.request('GET', path(lead.id));

      if (UNPRIVILEGED.includes(role)) {
        expect(response.status).toBe(403);
        expect((await problemOf(response)).code).toBe('forbidden');
      } else if (mfa === 'aal1') {
        expect(response.status).toBe(403);
        expect((await problemOf(response)).code).toBe('mfa_required');
      } else {
        // AAL2 is enough: the contract sets no maximum MFA age for the data export
        expect(response.status).toBe(200);
      }
      if (response.status === 403) {
        expect(t.harness.audit.entries).toEqual([
          expect.objectContaining({
            action: 'lead.data_exported',
            result: 'denied',
            resourceId: lead.id,
          }),
        ]);
      }
    },
  );

  it('delivers the subject data as an attachment, no-store, and audits it', async () => {
    const t = buildCrmApp();
    const lead = t.harness.seed(WORKSPACE_A);

    const response = await t.request('GET', path(lead.id));
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toBe(
      `attachment; filename="lead-data-export-${lead.id}.json"`,
    );
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body).toMatchObject({
      schema_version: '1',
      truncated: false,
      lead: { id: lead.id, whatsapp: '+5511912345678', email: lead.email },
      first_touch: { utm_source: 'meta', fbclid: 'IwAR1' },
    });
    expect(t.harness.audit.entries[0]).toMatchObject({
      action: 'lead.data_exported',
      result: 'success',
    });
  });

  it('uses the read bucket, fail-closed', async () => {
    const t = buildCrmApp();
    const lead = t.harness.seed(WORKSPACE_A);
    await t.request('GET', path(lead.id));
    expect(t.guards.limiterCalls).toEqual([{ bucket: 'read', fail: 'closed' }]);
  });

  it('404 for another workspace (AC-CRM-06), 400 for a bad id, 409 for an anonymized lead', async () => {
    const t = buildCrmApp();
    const foreign = t.harness.seed(WORKSPACE_B);
    const erased = t.harness.seed(WORKSPACE_A, { anonymizedAt: new Date('2026-11-04T00:00:00Z') });

    expect((await t.request('GET', path(foreign.id))).status).toBe(404);
    expect((await t.request('GET', path('nope'))).status).toBe(400);
    const conflict = await t.request('GET', path(erased.id));
    expect(conflict.status).toBe(409);
    expect((await problemOf(conflict)).code).toBe('lead_anonymized');
  });
});

describe('POST /v1/crm/leads/{id}/anonymize', () => {
  const path = (id: string) => `/v1/crm/leads/${id}/anonymize`;

  async function previewHash(t: CrmApp, id: string): Promise<string> {
    const response = await t.request('POST', path(id), { body: {} });
    return ((await response.json()) as { plan_hash: string }).plan_hash;
  }

  it.each(ALL_ROLES.flatMap((role) => MFA_STATES.map((mfa) => [role, mfa] as const)))(
    'preview as role %s with %s',
    async (role, mfa) => {
      const t = buildCrmApp();
      withMfa(t, role, mfa);
      const lead = t.harness.seed(WORKSPACE_A);

      const response = await t.request('POST', path(lead.id), { body: {} });

      if (UNPRIVILEGED.includes(role)) {
        expect(response.status).toBe(403);
        expect((await problemOf(response)).code).toBe('forbidden');
      } else if (mfa === 'aal1') {
        expect(response.status).toBe(403);
        expect((await problemOf(response)).code).toBe('mfa_required');
      } else {
        // a preview only needs AAL2; the 300 s freshness guards the destructive step
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ mode: 'preview', lead_version: 3 });
      }
      if (response.status === 403) {
        expect(t.harness.audit.entries[0]).toMatchObject({
          action: 'lead.anonymize_previewed',
          result: 'denied',
        });
      }
    },
  );

  it.each(ALL_ROLES.flatMap((role) => MFA_STATES.map((mfa) => [role, mfa] as const)))(
    'confirm as role %s with %s',
    async (role, mfa) => {
      const t = buildCrmApp();
      const lead = t.harness.seed(WORKSPACE_A);
      t.as('admin');
      const planHash = await previewHash(t, lead.id);
      withMfa(t, role, mfa);

      const response = await t.request('POST', path(lead.id), {
        headers: { 'Idempotency-Key': KEY_1 },
        body: { confirm: true, plan_hash: planHash },
      });

      if (UNPRIVILEGED.includes(role)) {
        expect(response.status).toBe(403);
        expect((await problemOf(response)).code).toBe('forbidden');
      } else if (mfa === 'aal1') {
        expect(response.status).toBe(403);
        expect((await problemOf(response)).code).toBe('mfa_required');
      } else if (mfa === 'aal2-stale') {
        expect(response.status).toBe(403);
        expect((await problemOf(response)).code).toBe('reauthentication_required');
      } else if (role === 'admin') {
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          mode: 'applied',
          lead_id: lead.id,
          version: 4,
        });
      } else {
        // the hash belongs to the admin who asked for the preview
        expect(response.status).toBe(409);
        expect((await problemOf(response)).code).toBe('plan_stale');
      }
      if (response.status === 403) {
        expect(t.harness.gateway.anonymizeCalls).toHaveLength(0);
        expect(t.harness.audit.entries.at(-1)).toMatchObject({
          action: 'lead.anonymized',
          result: 'denied',
        });
      }
    },
  );

  it('previews without changing anything and applies with the hash (AC-CRM-09)', async () => {
    // arrange
    const t = buildCrmApp();
    const lead = t.harness.seed(WORKSPACE_A);
    const before = JSON.stringify(t.harness.leads.all());
    // act
    const preview = await t.request('POST', path(lead.id), { body: { confirm: false } });
    const previewBody = (await preview.json()) as { plan_hash: string; will_erase: unknown[] };
    const unchanged = JSON.stringify(t.harness.leads.all());
    const applied = await t.request('POST', path(lead.id), {
      headers: { 'Idempotency-Key': KEY_1 },
      body: { confirm: true, plan_hash: previewBody.plan_hash },
    });
    // assert
    expect(preview.status).toBe(200);
    expect(previewBody.will_erase).toHaveLength(8);
    expect(unchanged).toBe(before);
    expect(applied.status).toBe(200);
    expect(t.harness.leads.all()[0]?.anonymizedAt).not.toBeNull();
    expect(t.harness.auditActions()).toEqual([
      'lead.anonymize_previewed:success',
      'lead.anonymized:success',
    ]);
  });

  it('takes the write bucket, fail-closed', async () => {
    const t = buildCrmApp();
    const lead = t.harness.seed(WORKSPACE_A);
    await t.request('POST', path(lead.id), { body: {} });
    expect(t.guards.limiterCalls).toEqual([{ bucket: 'write', fail: 'closed' }]);
  });

  it('400 idempotency_key_missing on confirm without the header; the preview needs none', async () => {
    const t = buildCrmApp();
    const lead = t.harness.seed(WORKSPACE_A);
    const hash = await previewHash(t, lead.id);

    const response = await t.request('POST', path(lead.id), {
      body: { confirm: true, plan_hash: hash },
    });

    expect(response.status).toBe(400);
    expect((await problemOf(response)).code).toBe('idempotency_key_missing');
  });

  it('400 when confirm is true without plan_hash (ST-26)', async () => {
    const t = buildCrmApp();
    const lead = t.harness.seed(WORKSPACE_A);
    const response = await t.request('POST', path(lead.id), {
      headers: { 'Idempotency-Key': KEY_1 },
      body: { confirm: true },
    });
    expect(response.status).toBe(400);
  });

  it('409 plan_stale after the lead changed since the preview; nothing is erased', async () => {
    const t = buildCrmApp();
    const lead = t.harness.seed(WORKSPACE_A);
    const hash = await previewHash(t, lead.id);
    await t.request('PATCH', `/v1/crm/leads/${lead.id}/stage`, {
      body: { to_stage: 'contacted', expected_version: 3 },
    });

    const response = await t.request('POST', path(lead.id), {
      headers: { 'Idempotency-Key': KEY_1 },
      body: { confirm: true, plan_hash: hash },
    });

    expect(response.status).toBe(409);
    expect((await problemOf(response)).code).toBe('plan_stale');
    expect(t.harness.gateway.anonymizeCalls).toHaveLength(0);
  });

  it('409 lead_anonymized on a second application, and the first key replays 200', async () => {
    const t = buildCrmApp();
    const lead = t.harness.seed(WORKSPACE_A);
    const hash = await previewHash(t, lead.id);
    const send = (key: string) =>
      t.request('POST', path(lead.id), {
        headers: { 'Idempotency-Key': key },
        body: { confirm: true, plan_hash: hash },
      });

    const first = await send(KEY_1);
    const replay = await send(KEY_1);
    const second = await send('33333333-3333-4333-8333-333333333333');

    expect(first.status).toBe(200);
    expect(await replay.json()).toEqual(await first.json());
    expect(second.status).toBe(409);
    expect((await problemOf(second)).code).toBe('lead_anonymized');
    expect(t.harness.gateway.anonymizeCalls).toHaveLength(1);
  });

  it('404 for another workspace (AC-CRM-06) for preview and confirm', async () => {
    const t = buildCrmApp();
    const foreign = t.harness.seed(WORKSPACE_B);
    const preview = await t.request('POST', path(foreign.id), { body: {} });
    const confirm = await t.request('POST', path(foreign.id), {
      headers: { 'Idempotency-Key': KEY_1 },
      body: { confirm: true, plan_hash: 'a'.repeat(43) },
    });
    expect([preview.status, confirm.status]).toEqual([404, 404]);
  });

  it('keeps hashes and PII out of audit rows and logs', async () => {
    const t = buildCrmApp();
    const lead = t.harness.seed(WORKSPACE_A);
    const hash = await previewHash(t, lead.id);
    await t.request('POST', path(lead.id), {
      headers: { 'Idempotency-Key': KEY_1 },
      body: { confirm: true, plan_hash: hash },
    });
    const everything = JSON.stringify(t.harness.audit.entries) + t.logLines.join('');
    expect(everything).not.toContain(hash);
    expect(everything).not.toMatch(/maria|empresa|\+5511/i);
  });

  it('415 for a non-JSON body after the lead checks, 400 for malformed JSON', async () => {
    const t = buildCrmApp();
    const lead = t.harness.seed(WORKSPACE_A);
    const wrongType = await t.request('POST', path(lead.id), {
      headers: { 'Content-Type': 'text/plain' },
      body: 'x',
    });
    const malformed = await t.request('POST', path(lead.id), { body: '{bad' });
    expect(wrongType.status).toBe(415);
    expect(malformed.status).toBe(400);
  });
});

describe('route inventory', () => {
  it('exposes exactly the contract operations of this slice', () => {
    const t = buildCrmApp();
    const routes = t.app.routes
      .map((route) => `${route.method} ${route.path}`)
      .filter((entry) => entry.includes('/v1/crm/'));
    expect(new Set(routes)).toEqual(
      new Set([
        'GET /v1/crm/leads/export.csv',
        'GET /v1/crm/leads/:id/data-export',
        'POST /v1/crm/leads/:id/anonymize',
        'PATCH /v1/crm/leads/:id/stage',
        'PATCH /v1/crm/leads/:id/owner',
        'POST /v1/crm/leads/:id/notes',
      ]),
    );
  });

  it('requires a privileged role on every sensitive route (x-roles)', async () => {
    for (const role of UNPRIVILEGED) {
      const t = buildCrmApp();
      t.as(role);
      const lead = t.harness.seed(WORKSPACE_A);
      const statuses = await Promise.all([
        t.request('GET', '/v1/crm/leads/export.csv'),
        t.request('GET', `/v1/crm/leads/${lead.id}/data-export`),
        t.request('POST', `/v1/crm/leads/${lead.id}/anonymize`, { body: {} }),
      ]);
      expect(statuses.map((r) => r.status)).toEqual([403, 403, 403]);
    }
    expect(PRIVILEGED).toEqual(['owner', 'admin']);
  });
});
