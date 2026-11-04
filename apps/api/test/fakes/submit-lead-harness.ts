import type { CorrelationId, FormId, IdempotencyKey } from '#/shared/ids.ts';
import { createHmacHasher } from '#/platform/crypto/hashing.ts';
import {
  createSubmitLead,
  type SubmitLeadCommand,
} from '#/modules/lead-capture/application/submit-lead.ts';
import type { FormDefinition } from '#/modules/lead-capture/application/ports.ts';
import { createRegisterInboundLead } from '#/modules/crm/public-api.ts';
import { CallLog } from './call-log.ts';
import { FakeClock } from './clock.ts';
import { OTHER_WORKSPACE_ID, WORKSPACE_ID } from './crm-harness.ts';
import { FakeIcpSettingsProvider, FakeLeadActivityRepository, FakeLeadRepository } from './crm.ts';
import { SequentialIdGenerator } from './ids.ts';
import {
  FakeAntiBotVerifier,
  FakeAuditLogWriter,
  FakeConsentRepository,
  FakeFormLookup,
  FakeIdempotencyStore,
  FakeOutboxDispatchTrigger,
  FakeOutboxWriter,
  FakeRateLimiter,
  FakeSubmissionRepository,
} from './lead-capture.ts';
import { FakeUnitOfWork, TransactionRegistry } from './transactions.ts';

export { OTHER_WORKSPACE_ID, WORKSPACE_ID };

export const ORIGIN = 'https://www.dominio.com.br';
export const CLIENT_IP = '203.0.113.7';
export const IDEMPOTENCY_KEY = '11111111-1111-4111-8111-111111111111' as IdempotencyKey;
export const CLIENT_EVENT_ID = '5b1f7d2e-9a34-4c6b-8e10-1a2b3c4d5e6f';
export const CORRELATION_ID = '00000000-0000-4000-8000-00000000c0de' as CorrelationId;
const PEPPER = Buffer.alloc(32, 7).toString('base64');

export const FORM: FormDefinition = {
  id: '00000000-0000-7000-8000-00000000f0a1' as FormId,
  workspaceId: WORKSPACE_ID,
  formKey: 'frm_lp_principal',
  allowedOrigins: [ORIGIN],
  turnstileAction: 'lead_submit',
  privacyPolicyVersion: '2026-11-03',
};

export const OTHER_FORM: FormDefinition = {
  id: '00000000-0000-7000-8000-00000000f0a2' as FormId,
  workspaceId: OTHER_WORKSPACE_ID,
  formKey: 'frm_outro_cliente',
  allowedOrigins: ['https://www.outro.com.br'],
  turnstileAction: 'lead_submit',
  privacyPolicyVersion: '2026-10-01',
};

/** A valid request body (lead-capture §3); overrides replace top-level keys. */
export function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    form_key: FORM.formKey,
    turnstile_token: '0.AbCdEf',
    first_name: 'Maria',
    last_name: 'Silva',
    email: 'Maria@Empresa.com.br',
    whatsapp: '+55 (11) 91234-5678',
    company: 'Empresa Ltda',
    area_of_expertise: 'technology',
    marketing_opt_in: true,
    privacy_consent: true,
    hp: '',
    consent: { analytics_storage: 'granted', ad_user_data: 'granted' },
    tracking: {
      event_id: CLIENT_EVENT_ID,
      utm_source: 'meta',
      fbclid: 'IwAR123',
      landing_page_url: `${ORIGIN}/?utm_source=meta`,
    },
    ...overrides,
  };
}

export function aSubmitCommand(overrides: Partial<SubmitLeadCommand> = {}): SubmitLeadCommand {
  return {
    body: validBody(),
    origin: ORIGIN,
    idempotencyKey: IDEMPOTENCY_KEY,
    clientIp: CLIENT_IP,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) TestBrowser/1.0',
    correlationId: CORRELATION_ID,
    ...overrides,
  };
}

/** SubmitLead and the real crm use case wired to in-memory ports sharing one fake unit of work. */
export function createSubmitLeadHarness(forms: readonly FormDefinition[] = [FORM, OTHER_FORM]) {
  const log = new CallLog();
  const registry = new TransactionRegistry();
  const clock = new FakeClock();
  const ids = new SequentialIdGenerator();
  const hmac = createHmacHasher(PEPPER);

  const formLookup = new FakeFormLookup(forms, log);
  const rateLimiter = new FakeRateLimiter(log);
  const antiBot = new FakeAntiBotVerifier(log);
  const idempotency = new FakeIdempotencyStore(log);
  const submissions = new FakeSubmissionRepository(registry, log);
  const consents = new FakeConsentRepository(registry, log);
  const outbox = new FakeOutboxWriter(registry, log);
  const audit = new FakeAuditLogWriter(registry, log);
  const dispatch = new FakeOutboxDispatchTrigger(log);
  const leads = new FakeLeadRepository(registry, log);
  const activities = new FakeLeadActivityRepository(registry, log);
  const icp = new FakeIcpSettingsProvider();
  const unitOfWork = new FakeUnitOfWork(
    registry,
    [leads, activities, submissions, consents, outbox, audit],
    log,
  );

  const registerInboundLead = createRegisterInboundLead({ leads, activities, icp, ids });
  const submitLead = createSubmitLead({
    forms: formLookup,
    rateLimiter,
    antiBot,
    idempotency,
    unitOfWork,
    submissions,
    consents,
    outbox,
    audit,
    registerInboundLead,
    triggerOutboxDispatch: dispatch.trigger,
    clock,
    ids,
    hmac,
  });

  const submit = (overrides: Partial<SubmitLeadCommand> = {}) =>
    submitLead(aSubmitCommand(overrides));

  /** Number of rows written by a successful submission, across every table. */
  const persistedRows = () => ({
    leads: leads.all().length,
    activities: activities.records.length,
    submissions: submissions.records.length,
    consents: consents.records.length,
    outbox: outbox.events.length,
    audit: audit.entries.length,
  });

  return {
    log,
    registry,
    clock,
    ids,
    hmac,
    forms: formLookup,
    rateLimiter,
    antiBot,
    idempotency,
    submissions,
    consents,
    outbox,
    audit,
    dispatch,
    leads,
    activities,
    icp,
    unitOfWork,
    submitLead,
    submit,
    persistedRows,
  };
}

export type SubmitLeadHarness = ReturnType<typeof createSubmitLeadHarness>;
