import { describe, expect, it, vi } from 'vitest';
import type { IdempotencyKey } from '#/shared/ids.ts';
import { sha256Hex } from '#/platform/crypto/hashing.ts';
import {
  HONEYPOT_SIMULATED_LATENCY_MS,
  UNKNOWN_CLIENT_IP,
  type SubmitLeadAccepted,
  type SubmitLeadFailure,
  type SubmitLeadResult,
} from '#/modules/lead-capture/application/submit-lead.ts';
import { canonicalizeForIdempotency } from '#/modules/lead-capture/domain/idempotency.ts';
import { parseSubmission } from '#/modules/lead-capture/domain/submission.ts';
import {
  CLIENT_EVENT_ID,
  CLIENT_IP,
  CORRELATION_ID,
  FORM,
  IDEMPOTENCY_KEY,
  ORIGIN,
  OTHER_FORM,
  OTHER_WORKSPACE_ID,
  WORKSPACE_ID,
  createSubmitLeadHarness,
  validBody,
} from './fakes/submit-lead-harness.ts';

const SECOND_KEY = '22222222-2222-4222-8222-222222222222' as IdempotencyKey;
const SECOND_EVENT_ID = '6d2e8f3a-1b45-4d7c-9f21-2b3c4d5e6f71';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMPTY_ROWS = {
  leads: 0,
  activities: 0,
  submissions: 0,
  consents: 0,
  outbox: 0,
  audit: 0,
};

function accepted(result: SubmitLeadResult): SubmitLeadAccepted {
  if (!result.ok) {
    throw new Error(`expected an accepted submission, got ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

function refused(result: SubmitLeadResult): SubmitLeadFailure {
  if (result.ok) {
    throw new Error('expected a refusal');
  }
  return result.error;
}

/** A second, distinct submission of the same person (new intent: new key and event id). */
function secondIntent(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: SECOND_KEY,
    body: validBody({ tracking: { event_id: SECOND_EVENT_ID }, ...overrides }),
  };
}

describe('SubmitLead: accepted submission (steps 4–12)', () => {
  it('AC-LC-01: persists lead, submission, 3 consents, activity, outbox event and audit in one transaction', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    // act
    const result = accepted(await h.submit());
    // assert
    expect(result.outcome).toBe('accepted');
    expect(result.accepted.submissionId).toMatch(UUID);
    expect(result.accepted.eventId).toBe(CLIENT_EVENT_ID);
    expect(h.persistedRows()).toEqual({
      leads: 1,
      activities: 1,
      submissions: 1,
      consents: 3,
      outbox: 1,
      audit: 1,
    });
    expect(h.unitOfWork.scopes).toEqual([WORKSPACE_ID]);
    expect(h.unitOfWork.committed).toBe(1);
    expect(h.submissions.records[0]?.id).toBe(result.accepted.submissionId);
    expect(h.registry.openCount).toBe(0);
  });

  it('follows the fixed order of lead-capture §2', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    // act
    await h.submit();
    // assert
    expect(h.log.entries).toEqual([
      'rateLimiter.checkIp',
      'forms.findActiveByKey',
      'rateLimiter.checkForm',
      'antiBot.verify',
      'idempotency.claim',
      'rateLimiter.checkEmail',
      'uow.run',
      'leads.findActiveByEmailForUpdate',
      'leads.insertIfAbsent',
      'activities.append:submission_received',
      'submissions.insert',
      'consents.appendMany',
      'outbox.enqueue',
      'audit.append',
      'idempotency.complete',
      'dispatch.trigger',
    ]);
  });

  it('asks Turnstile for the form hostnames and action, forwarding the client IP and the key', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    // act
    await h.submit();
    // assert
    expect(h.antiBot.requests).toEqual([
      {
        token: '0.AbCdEf',
        remoteIp: CLIENT_IP,
        expectedHostnames: ['www.dominio.com.br'],
        expectedAction: 'lead_submit',
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    ]);
  });

  it('stores the normalized submission with the HMAC of the IP and the request hash', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    const body = validBody();
    const parsed = parseSubmission(body, { allowedOrigins: [ORIGIN] });
    if (!parsed.ok) {
      throw new Error('fixture must be valid');
    }
    // act
    const result = accepted(await h.submit({ body }));
    // assert
    const record = h.submissions.records[0];
    expect(record).toMatchObject({
      id: result.accepted.submissionId,
      workspaceId: WORKSPACE_ID,
      formId: FORM.id,
      idempotencyKey: IDEMPOTENCY_KEY,
      eventId: CLIENT_EVENT_ID,
      message: null,
      clientIp: CLIENT_IP,
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) TestBrowser/1.0',
      antibot: { provider: 'turnstile', challengeAgeSeconds: 4, ephemeralId: null },
      createdAt: h.clock.now(),
    });
    expect(record?.requestHash).toBe(sha256Hex(canonicalizeForIdempotency(parsed.value.snapshot)));
    expect(record?.ipHmac).toBe(h.hmac(CLIENT_IP));
    expect(record?.ipHmac).not.toContain(CLIENT_IP);
    expect(record?.fields).toEqual({
      first_name: 'Maria',
      last_name: 'Silva',
      email: 'maria@empresa.com.br',
      whatsapp: '+5511912345678',
      company: 'Empresa Ltda',
      area_of_expertise: 'technology',
      area_of_expertise_other: null,
      job_title: null,
      company_size: null,
      company_website: null,
      marketing_opt_in: true,
      privacy_consent: true,
    });
    expect(record?.attribution).toMatchObject({
      utmSource: 'meta',
      fbclid: 'IwAR123',
      landingPageUrl: `${ORIGIN}/?utm_source=meta`,
    });
    expect(record?.consentState).toEqual({
      analyticsStorage: 'granted',
      adStorage: 'denied',
      adUserData: 'granted',
      adPersonalization: 'denied',
    });
  });

  it('generates the event id when the client sends none or an invalid one, and returns the stored one', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    // act
    const missing = accepted(await h.submit({ body: validBody({ tracking: {} }) }));
    const invalid = accepted(
      await h.submit({
        idempotencyKey: SECOND_KEY,
        body: validBody({ tracking: { event_id: 'not-a-uuid' } }),
      }),
    );
    // assert
    expect(missing.accepted.eventId).toMatch(UUID);
    expect(invalid.accepted.eventId).toMatch(UUID);
    expect(missing.accepted.eventId).not.toBe(invalid.accepted.eventId);
    expect(h.submissions.records.map((record) => record.eventId)).toEqual([
      missing.accepted.eventId,
      invalid.accepted.eventId,
    ]);
  });

  it('discards a landing page outside the form origins instead of rejecting the lead', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    const body = validBody({ tracking: { landing_page_url: 'https://evil.example/?x=1' } });
    // act
    accepted(await h.submit({ body }));
    // assert
    expect(h.submissions.records[0]?.attribution.landingPageUrl).toBeNull();
  });

  it('truncates the user agent to 512 code points and stores null for an empty one', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    // act
    accepted(await h.submit({ userAgent: 'a'.repeat(600) }));
    accepted(await h.submit({ ...secondIntent(), userAgent: '' }));
    // assert
    expect(h.submissions.records[0]?.userAgent).toHaveLength(512);
    expect(h.submissions.records[1]?.userAgent).toBeNull();
  });

  it('keeps working without a client IP: one shared bucket, no raw IP stored', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    // act
    accepted(await h.submit({ clientIp: null }));
    // assert
    expect(h.rateLimiter.checkedIps).toEqual([UNKNOWN_CLIENT_IP]);
    expect(h.antiBot.requests[0]?.remoteIp).toBeNull();
    expect(h.submissions.records[0]).toMatchObject({
      clientIp: null,
      ipHmac: h.hmac(UNKNOWN_CLIENT_IP),
    });
  });

  it('checks the limiters with the normalized e-mail and the form key', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    // act
    await h.submit();
    // assert
    expect(h.rateLimiter.checkedIps).toEqual([CLIENT_IP]);
    expect(h.rateLimiter.checkedForms).toEqual([FORM.formKey]);
    expect(h.rateLimiter.checkedEmails).toEqual(['maria@empresa.com.br']);
  });
});

describe('SubmitLead: consents (R4), outbox (R6) and audit', () => {
  it('R4: records privacy_policy always, marketing from the opt-in and ad_tracking from ad_user_data', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    // act
    const result = accepted(await h.submit());
    // assert
    expect(h.consents.records.map(({ purpose, granted }) => ({ purpose, granted }))).toEqual([
      { purpose: 'privacy_policy', granted: true },
      { purpose: 'marketing_communications', granted: true },
      { purpose: 'ad_tracking', granted: true },
    ]);
    for (const consent of h.consents.records) {
      expect(consent).toMatchObject({
        workspaceId: WORKSPACE_ID,
        submissionId: result.accepted.submissionId,
        policyVersion: '2026-11-03',
        createdAt: h.clock.now(),
      });
      expect(consent.id).toMatch(UUID);
    }
  });

  it('R4: without opt-in or consent object, marketing and ad_tracking are recorded as denied', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    const body = validBody({ marketing_opt_in: false });
    delete body.consent;
    // act
    accepted(await h.submit({ body }));
    // assert
    expect(h.consents.records.map((consent) => consent.granted)).toEqual([true, false, false]);
  });

  it('R4: ad_tracking follows ad_user_data only, not the other Consent Mode signals', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    const body = validBody({ consent: { ad_storage: 'granted', ad_personalization: 'granted' } });
    // act
    accepted(await h.submit({ body }));
    // assert
    expect(h.consents.records[2]).toMatchObject({ purpose: 'ad_tracking', granted: false });
  });

  it('R6: enqueues lead.captured in the same commit with IDs only and publishes after the commit', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    // act
    const result = accepted(await h.submit());
    // assert
    const lead = h.leads.all()[0];
    const event = h.outbox.events[0];
    expect(event).toMatchObject({
      workspaceId: WORKSPACE_ID,
      aggregateType: 'lead',
      aggregateId: lead?.id,
      eventType: 'lead.captured',
      payload: { lead_id: lead?.id, submission_id: result.accepted.submissionId },
      createdAt: h.clock.now(),
    });
    const serialized = JSON.stringify(event);
    for (const pii of ['maria', 'Maria', 'Silva', 'Empresa', '+5511', CLIENT_IP]) {
      expect(serialized).not.toContain(pii);
    }
    expect(h.dispatch.calls).toEqual([{ outboxEventId: event?.id, correlationId: CORRELATION_ID }]);
    expect(h.log.entries.indexOf('dispatch.trigger')).toBeGreaterThan(
      h.log.entries.indexOf('outbox.enqueue'),
    );
  });

  it('R6: a throwing publish trigger never fails the accepted request', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    h.dispatch.throwOnCall = new Error('qstash down');
    // act
    const result = await h.submit();
    // assert
    expect(accepted(result).outcome).toBe('accepted');
    expect(h.persistedRows().outbox).toBe(1);
  });

  it('writes an audit entry with IDs and codes only', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    // act
    const result = accepted(await h.submit());
    // assert
    const entry = h.audit.entries[0];
    expect(entry).toMatchObject({
      workspaceId: WORKSPACE_ID,
      actorType: 'system',
      actorId: null,
      action: 'lead.captured',
      resourceType: 'submission',
      resourceId: result.accepted.submissionId,
      result: 'success',
      correlationId: CORRELATION_ID,
      metadata: {
        lead_id: h.leads.all()[0]?.id,
        form_id: FORM.id,
        event_id: CLIENT_EVENT_ID,
        lead_created: true,
      },
    });
    const serialized = JSON.stringify(entry);
    for (const pii of ['maria', 'Maria', 'Silva', '+5511', CLIENT_IP]) {
      expect(serialized).not.toContain(pii);
    }
  });
});

describe('SubmitLead: dedupe (R1) and anti-enumeration (R2)', () => {
  it('AC-LC-04: a second submission of the same e-mail keeps one lead and counts the submission', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    const first = accepted(await h.submit());
    // act
    const second = accepted(await h.submit(secondIntent({ first_name: 'Mariana' })));
    // assert
    expect(h.persistedRows()).toMatchObject({
      leads: 1,
      submissions: 2,
      consents: 6,
    });
    // the recurrence points (+15) also move the lead from band C to B: a score_changed activity
    expect(h.activities.records.map((activity) => activity.type)).toEqual([
      'submission_received',
      'submission_received',
      'score_changed',
    ]);
    expect(h.leads.all()[0]).toMatchObject({ submissionsCount: 2, firstName: 'Mariana' });
    expect(Object.keys(second.accepted).sort()).toEqual(Object.keys(first.accepted).sort());
    expect(second.accepted.submissionId).not.toBe(first.accepted.submissionId);
    expect(h.audit.entries[1]?.metadata).toMatchObject({ lead_created: false });
  });

  it('R1: e-mails differing only in case or spacing are the same lead', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    await h.submit();
    // act
    accepted(await h.submit(secondIntent({ email: '  MARIA@EMPRESA.COM.BR ' })));
    // assert
    expect(h.leads.all()).toHaveLength(1);
  });

  it('R2: new lead, existing lead and honeypot yield the same response shape and outcome class', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    const newLead = accepted(await h.submit());
    const existing = accepted(await h.submit(secondIntent()));
    const honeypot = accepted(
      await h.submit({
        idempotencyKey: '33333333-3333-4333-8333-333333333333' as IdempotencyKey,
        body: validBody({ hp: 'http://spam.example', tracking: { event_id: CLIENT_EVENT_ID } }),
      }),
    );
    // assert
    for (const result of [newLead, existing, honeypot]) {
      expect(Object.keys(result.accepted).sort()).toEqual(['eventId', 'submissionId']);
      expect(result.accepted.submissionId).toMatch(UUID);
      expect(result.accepted.eventId).toMatch(UUID);
    }
    expect([newLead.outcome, existing.outcome]).toEqual(['accepted', 'accepted']);
  });

  it('R5: first touch is kept and last touch replaced across submissions (through SubmitLead)', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    await h.submit();
    // act
    await h.submit(
      secondIntent({
        tracking: { event_id: SECOND_EVENT_ID, utm_source: 'google', gclid: 'Cj0K' },
      }),
    );
    // assert
    const lead = h.leads.all()[0];
    expect(lead?.firstTouch).toMatchObject({ utmSource: 'meta', fbclid: 'IwAR123' });
    expect(lead?.lastTouch).toMatchObject({ utmSource: 'google', gclid: 'Cj0K' });
    expect(h.submissions.records[0]?.attribution.utmSource).toBe('meta');
    expect(h.submissions.records[1]?.attribution.utmSource).toBe('google');
  });
});

describe('SubmitLead: honeypot (R3, AC-LC-05)', () => {
  const trapped = () => validBody({ hp: 'https://spam.example' });

  it('AC-LC-05: answers like a success and persists nothing anywhere', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    // act
    const result = accepted(await h.submit({ body: trapped() }));
    // assert
    expect(result.outcome).toBe('honeypot');
    expect(result.accepted.submissionId).toMatch(UUID);
    expect(h.persistedRows()).toEqual(EMPTY_ROWS);
    expect(h.unitOfWork.scopes).toEqual([]);
    expect(h.dispatch.calls).toEqual([]);
    expect(h.idempotency.completions).toEqual([]);
  });

  it('waits the simulated latency on the injected clock, without really sleeping', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    // act
    await h.submit({ body: trapped() });
    // assert
    expect(h.clock.sleeps).toEqual([HONEYPOT_SIMULATED_LATENCY_MS]);
  });

  it('skips the idempotency claim and the e-mail limiter, and returns a fresh random id each time', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    // act
    const first = accepted(await h.submit({ body: trapped() }));
    const second = accepted(await h.submit({ body: trapped() }));
    // assert
    expect(h.log.matching('idempotency')).toEqual([]);
    expect(h.log.matching('rateLimiter.checkEmail')).toEqual([]);
    expect(first.accepted.submissionId).not.toBe(second.accepted.submissionId);
  });

  it('still requires human proof: a failed Turnstile wins over the honeypot', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    h.antiBot.outcome = { outcome: 'failed', reason: 'invalid_token' };
    // act
    const failure = refused(await h.submit({ body: trapped() }));
    // assert
    expect(failure.code).toBe('bot_verification_failed');
    expect(h.clock.sleeps).toEqual([]);
  });

  it('keeps the validation order: invalid fields are refused before the honeypot is looked at', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    // act
    const failure = refused(await h.submit({ body: validBody({ hp: 'x', email: 'nope' }) }));
    // assert
    expect(failure).toEqual({
      code: 'validation_failed',
      errors: [{ field: 'email', code: 'invalid_format' }],
    });
  });
});

describe('SubmitLead: refusals before persistence (steps 4–7)', () => {
  it('AC-LC-08: a blocked IP is refused first, with Retry-After, and nothing else runs', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    h.rateLimiter.ip = { allowed: false, retryAfterSeconds: 420 };
    // act
    const failure = refused(await h.submit());
    // assert
    expect(failure).toEqual({ code: 'rate_limited', scope: 'ip', retryAfterSeconds: 420 });
    expect(h.log.entries).toEqual(['rateLimiter.checkIp']);
  });

  it('rejects a malformed envelope before the form lookup and the Turnstile call', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    // act
    const failure = refused(await h.submit({ body: { form_key: 'FRM', first_name: 'Maria' } }));
    // assert
    expect(failure).toEqual({
      code: 'validation_failed',
      errors: [
        { field: 'form_key', code: 'invalid_format' },
        { field: 'turnstile_token', code: 'required' },
      ],
    });
    expect(h.log.entries).toEqual(['rateLimiter.checkIp']);
  });

  it('answers form_not_found for an unknown or paused form without calling Turnstile', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    const unknown = refused(await h.submit({ body: validBody({ form_key: 'frm_inexistente' }) }));
    h.forms.deactivate(FORM.formKey);
    // act
    const paused = refused(await h.submit());
    // assert
    expect(unknown).toEqual({ code: 'form_not_found' });
    expect(paused).toEqual({ code: 'form_not_found' });
    expect(h.antiBot.requests).toEqual([]);
  });

  it.each([
    ['an Origin outside the form allowlist', 'https://evil.example'],
    ['the Origin of another form', 'https://www.outro.com.br'],
    ['a missing Origin', null],
  ])('AC-LC-07: refuses %s with origin_not_allowed, before Turnstile', async (_label, origin) => {
    // arrange
    const h = createSubmitLeadHarness();
    // act
    const failure = refused(await h.submit({ origin }));
    // assert
    expect(failure).toEqual({ code: 'origin_not_allowed' });
    expect(h.antiBot.requests).toEqual([]);
    expect(h.rateLimiter.checkedForms).toEqual([]);
  });

  it('refuses a flooded form with rate_limited before Turnstile', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    h.rateLimiter.form = { allowed: false, retryAfterSeconds: 30 };
    // act
    const failure = refused(await h.submit());
    // assert
    expect(failure).toEqual({ code: 'rate_limited', scope: 'form', retryAfterSeconds: 30 });
    expect(h.antiBot.requests).toEqual([]);
  });

  it('AC-LC-06: a failed Turnstile is a 403 cause, counts towards the IP block and skips field validation', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    h.antiBot.outcome = { outcome: 'failed', reason: 'token_reused' };
    const invalidBody = validBody({ first_name: 12, email: 'nope', stage: 'won' });
    // act
    const failure = refused(await h.submit({ body: invalidBody }));
    // assert
    expect(failure).toEqual({ code: 'bot_verification_failed', reason: 'token_reused' });
    expect(h.rateLimiter.botFailures).toEqual([CLIENT_IP]);
    expect(h.log.matching('idempotency')).toEqual([]);
    expect(h.persistedRows()).toEqual(EMPTY_ROWS);
  });

  it('fails closed with bot_verification_unavailable when Turnstile cannot be reached, without counting a bot failure', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    h.antiBot.outcome = { outcome: 'unavailable' };
    // act
    const failure = refused(await h.submit());
    // assert
    expect(failure).toEqual({ code: 'bot_verification_unavailable' });
    expect(h.rateLimiter.botFailures).toEqual([]);
    expect(h.persistedRows()).toEqual(EMPTY_ROWS);
  });

  it('AC-LC-02: a missing required field is validation_failed with code required, after Turnstile', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    const body = validBody();
    delete body.whatsapp;
    // act
    const failure = refused(await h.submit({ body }));
    // assert
    expect(failure).toEqual({
      code: 'validation_failed',
      errors: [{ field: 'whatsapp', code: 'required' }],
    });
    expect(h.antiBot.requests).toHaveLength(1);
    expect(h.persistedRows()).toEqual(EMPTY_ROWS);
    expect(h.log.matching('idempotency')).toEqual([]);
  });

  it('AC-LC-03: privacy_consent = false is refused with must_be_true', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    // act
    const failure = refused(await h.submit({ body: validBody({ privacy_consent: false }) }));
    // assert
    expect(failure).toEqual({
      code: 'validation_failed',
      errors: [{ field: 'privacy_consent', code: 'must_be_true' }],
    });
  });

  it('AC-LC-11: an unknown field is refused with not_allowed', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    // act
    const failure = refused(await h.submit({ body: validBody({ stage: 'won' }) }));
    // assert
    expect(failure).toEqual({
      code: 'validation_failed',
      errors: [{ field: 'stage', code: 'not_allowed' }],
    });
  });

  it('never reflects the received values in a refusal', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    const body = validBody({
      first_name: '<script>alert(1)</script>',
      email: 'leak@evil.example!',
    });
    // act
    const failure = refused(await h.submit({ body }));
    // assert
    const serialized = JSON.stringify(failure);
    expect(serialized).not.toContain('script');
    expect(serialized).not.toContain('leak@');
  });
});

describe('SubmitLead: idempotency (R7)', () => {
  it('AC-LC-09: the same key and payload with a new Turnstile token replays the first response', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    const first = accepted(await h.submit());
    h.log.clear();
    // act
    const retry = accepted(await h.submit({ body: validBody({ turnstile_token: '0.NewToken' }) }));
    // assert
    expect(retry.outcome).toBe('replayed');
    expect(retry.accepted).toEqual(first.accepted);
    expect(h.persistedRows()).toMatchObject({ leads: 1, submissions: 1, consents: 3, outbox: 1 });
    expect(h.leads.all()[0]?.submissionsCount).toBe(1);
    expect(h.antiBot.requests.map((request) => request.token)).toEqual(['0.AbCdEf', '0.NewToken']);
    expect(h.log.entries).toEqual([
      'rateLimiter.checkIp',
      'forms.findActiveByKey',
      'rateLimiter.checkForm',
      'antiBot.verify',
      'idempotency.claim',
    ]);
    expect(h.dispatch.calls).toHaveLength(1);
  });

  it('R7: a replay ignores cosmetic differences that normalize to the same payload', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    const first = accepted(await h.submit());
    // act
    const retry = accepted(
      await h.submit({
        body: validBody({
          first_name: '  Maria ',
          email: 'MARIA@EMPRESA.COM.BR',
          whatsapp: '11912345678',
        }),
      }),
    );
    // assert
    expect(retry.outcome).toBe('replayed');
    expect(retry.accepted).toEqual(first.accepted);
  });

  it('AC-LC-10: the same key with a different payload is refused with idempotency_key_reused', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    await h.submit();
    const before = h.persistedRows();
    // act
    const failure = refused(await h.submit({ body: validBody({ first_name: 'Outra' }) }));
    // assert
    expect(failure).toEqual({ code: 'idempotency_key_reused' });
    expect(h.persistedRows()).toEqual(before);
  });

  it('answers idempotency_in_progress (Retry-After 1) while the same request is still processing', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    const parsed = parseSubmission(validBody(), { allowedOrigins: [ORIGIN] });
    if (!parsed.ok) {
      throw new Error('fixture must be valid');
    }
    h.idempotency.seedInProgress(
      WORKSPACE_ID,
      IDEMPOTENCY_KEY,
      sha256Hex(canonicalizeForIdempotency(parsed.value.snapshot)),
    );
    // act
    const failure = refused(await h.submit());
    // assert
    expect(failure).toEqual({ code: 'idempotency_in_progress', retryAfterSeconds: 1 });
    expect(h.persistedRows()).toEqual(EMPTY_ROWS);
  });

  it('treats an in-progress key with another payload as a reuse, not as progress', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    h.idempotency.seedInProgress(WORKSPACE_ID, IDEMPOTENCY_KEY, 'f'.repeat(64));
    // act
    const failure = refused(await h.submit());
    // assert
    expect(failure).toEqual({ code: 'idempotency_key_reused' });
  });

  it('scopes keys by workspace: the same key in another workspace is a different intent', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    await h.submit();
    // act
    const other = accepted(
      await h.submit({
        origin: OTHER_FORM.allowedOrigins[0] ?? null,
        body: validBody({ form_key: OTHER_FORM.formKey }),
      }),
    );
    // assert
    expect(other.outcome).toBe('accepted');
    expect(h.persistedRows()).toMatchObject({ leads: 2, submissions: 2 });
  });

  it('a blocked e-mail releases the claim, and the client can retry the same key once allowed', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    h.rateLimiter.email = { allowed: false, retryAfterSeconds: 3600 };
    // act
    const failure = refused(await h.submit());
    h.rateLimiter.email = { allowed: true };
    const retry = accepted(await h.submit());
    // assert
    expect(failure).toEqual({ code: 'rate_limited', scope: 'email', retryAfterSeconds: 3600 });
    expect(h.idempotency.releases).toEqual([`${WORKSPACE_ID}:${IDEMPOTENCY_KEY}`]);
    expect(retry.outcome).toBe('accepted');
    expect(h.persistedRows().submissions).toBe(1);
  });

  it('does not count a replay towards the e-mail limit', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    await h.submit();
    h.rateLimiter.email = { allowed: false, retryAfterSeconds: 3600 };
    // act
    const retry = accepted(await h.submit());
    // assert
    expect(retry.outcome).toBe('replayed');
    expect(h.rateLimiter.checkedEmails).toHaveLength(1);
  });

  it('fail-open on Redis: processes the request and neither completes nor releases a claim', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    h.idempotency.down = true;
    // act
    const result = accepted(await h.submit());
    // assert
    expect(result.outcome).toBe('accepted');
    expect(h.persistedRows().submissions).toBe(1);
    expect(h.idempotency.completions).toEqual([]);
    expect(h.idempotency.releases).toEqual([]);
  });

  it('with Redis down, the database UNIQUE replays the original response and rolls back the second upsert', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    h.idempotency.down = true;
    const first = accepted(await h.submit());
    // act
    const retry = accepted(await h.submit());
    // assert
    expect(retry.outcome).toBe('replayed');
    expect(retry.accepted).toEqual(first.accepted);
    expect(h.persistedRows()).toEqual({
      leads: 1,
      activities: 1,
      submissions: 1,
      consents: 3,
      outbox: 1,
      audit: 1,
    });
    expect(h.leads.all()[0]).toMatchObject({ submissionsCount: 1, version: 1 });
    expect(h.unitOfWork.rolledBack).toBe(1);
    expect(h.dispatch.calls).toHaveLength(1);
  });

  it('with Redis down, the database UNIQUE also refuses the same key with another payload', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    h.idempotency.down = true;
    await h.submit();
    // act
    const failure = refused(await h.submit({ body: validBody({ first_name: 'Outra' }) }));
    // assert
    expect(failure).toEqual({ code: 'idempotency_key_reused' });
    expect(h.leads.all()[0]).toMatchObject({ firstName: 'Maria', submissionsCount: 1 });
  });

  it('after the 24 h Redis TTL, a retry is replayed from the database and the claim is repopulated', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    const first = accepted(await h.submit());
    h.idempotency.forget(WORKSPACE_ID, IDEMPOTENCY_KEY);
    // act
    const retry = accepted(await h.submit());
    // assert
    expect(retry.outcome).toBe('replayed');
    expect(retry.accepted).toEqual(first.accepted);
    expect(h.idempotency.stateOf(WORKSPACE_ID, IDEMPOTENCY_KEY)).toMatchObject({
      state: 'completed',
      response: first.accepted,
    });
    expect(h.leads.all()[0]?.submissionsCount).toBe(1);
  });

  it('after the TTL, a different payload under the same key is refused and the claim is released', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    await h.submit();
    h.idempotency.forget(WORKSPACE_ID, IDEMPOTENCY_KEY);
    // act
    const failure = refused(await h.submit({ body: validBody({ first_name: 'Outra' }) }));
    // assert
    expect(failure).toEqual({ code: 'idempotency_key_reused' });
    expect(h.idempotency.stateOf(WORKSPACE_ID, IDEMPOTENCY_KEY)).toBeUndefined();
  });

  it('still replays when the unit of work wraps the rollback rejection in its own error', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    h.idempotency.down = true;
    const first = accepted(await h.submit());
    h.unitOfWork.wrapRejections = true;
    // act
    const retry = accepted(await h.submit());
    // assert
    expect(retry.outcome).toBe('replayed');
    expect(retry.accepted).toEqual(first.accepted);
    expect(h.leads.all()[0]?.submissionsCount).toBe(1);
  });

  it('treats a duplicate that cannot be found as an infrastructure error and frees the claim', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    vi.spyOn(h.submissions, 'insert').mockResolvedValueOnce('duplicate_idempotency_key');
    // act
    const outcome = h.submit();
    // assert
    await expect(outcome).rejects.toThrow('no submission was found');
    expect(h.idempotency.stateOf(WORKSPACE_ID, IDEMPOTENCY_KEY)).toBeUndefined();
    expect(h.persistedRows()).toEqual(EMPTY_ROWS);
  });

  it('a failing idempotency complete never turns a committed submission into an error', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    vi.spyOn(h.idempotency, 'complete').mockRejectedValueOnce(new Error('redis timeout'));
    // act
    const result = await h.submit();
    // assert
    expect(accepted(result).outcome).toBe('accepted');
    expect(h.persistedRows().submissions).toBe(1);
  });
});

describe('SubmitLead: infrastructure failures', () => {
  it('R6 / AC-LC-18: a failure after partial writes rolls everything back, frees the claim and rethrows', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    h.outbox.failure = new Error('connection terminated');
    // act
    const outcome = h.submit();
    // assert
    await expect(outcome).rejects.toThrow('connection terminated');
    expect(h.persistedRows()).toEqual(EMPTY_ROWS);
    expect(h.unitOfWork.rolledBack).toBe(1);
    expect(h.idempotency.releases).toEqual([`${WORKSPACE_ID}:${IDEMPOTENCY_KEY}`]);
    expect(h.idempotency.completions).toEqual([]);
    expect(h.dispatch.calls).toEqual([]);
  });

  it('lets the client retry the same key after a failed attempt', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    h.outbox.failure = new Error('connection terminated');
    await expect(h.submit()).rejects.toThrow();
    h.outbox.failure = null;
    // act
    const retry = accepted(await h.submit());
    // assert
    expect(retry.outcome).toBe('accepted');
    expect(h.persistedRows()).toMatchObject({ leads: 1, submissions: 1 });
  });

  it('rethrows the original error even when releasing the claim also fails', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    h.unitOfWork.failure = new Error('postgres unavailable');
    vi.spyOn(h.idempotency, 'release').mockRejectedValueOnce(new Error('redis timeout'));
    // act
    const outcome = h.submit();
    // assert
    await expect(outcome).rejects.toThrow('postgres unavailable');
    expect(h.persistedRows()).toEqual(EMPTY_ROWS);
  });

  it('does not release a claim it does not own when Redis is down', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    h.idempotency.down = true;
    h.unitOfWork.failure = new Error('postgres unavailable');
    // act
    const outcome = h.submit();
    // assert
    await expect(outcome).rejects.toThrow('postgres unavailable');
    expect(h.idempotency.releases).toEqual([]);
  });
});

describe('SubmitLead: tenancy', () => {
  it('derives the workspace from the form, never from the request: the same e-mail is two leads', async () => {
    // arrange
    const h = createSubmitLeadHarness();
    await h.submit();
    // act
    accepted(
      await h.submit({
        idempotencyKey: SECOND_KEY,
        origin: OTHER_FORM.allowedOrigins[0] ?? null,
        body: validBody({ form_key: OTHER_FORM.formKey, tracking: {} }),
      }),
    );
    // assert
    expect(h.unitOfWork.scopes).toEqual([WORKSPACE_ID, OTHER_WORKSPACE_ID]);
    expect(h.leads.all().map((lead) => lead.workspaceId)).toEqual([
      WORKSPACE_ID,
      OTHER_WORKSPACE_ID,
    ]);
    expect(h.consents.records.at(-1)?.policyVersion).toBe('2026-10-01');
  });
});
