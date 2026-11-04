import type { CorrelationId, SubmissionId, WorkspaceId } from '#/shared/ids.ts';
import type { AttributionSnapshot } from '#/shared/lead-profile.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';
import {
  createRegisterInboundLead,
  type InboundLeadProfile,
  type RegisterInboundLead,
  type RegisterInboundLeadCommand,
  type RegisterInboundLeadResult,
} from '#/modules/crm/public-api.ts';
import { CallLog } from './call-log.ts';
import { FakeIcpSettingsProvider, FakeLeadActivityRepository, FakeLeadRepository } from './crm.ts';
import { SequentialIdGenerator } from './ids.ts';
import { FakeUnitOfWork, TransactionRegistry } from './transactions.ts';

export const WORKSPACE_ID = '00000000-0000-7000-8000-00000000f001' as WorkspaceId;
export const OTHER_WORKSPACE_ID = '00000000-0000-7000-8000-00000000f002' as WorkspaceId;
export const CORRELATION_ID = '00000000-0000-4000-8000-00000000c0de' as CorrelationId;

export const NO_ATTRIBUTION: AttributionSnapshot = {
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  utmTerm: null,
  utmContent: null,
  utmId: null,
  gclid: null,
  gbraid: null,
  wbraid: null,
  fbclid: null,
  ttclid: null,
  msclkid: null,
  fbp: null,
  fbc: null,
  gaClientId: null,
  landingPageUrl: null,
  referrerUrl: null,
};

export function anInboundProfile(overrides: Partial<InboundLeadProfile> = {}): InboundLeadProfile {
  return {
    firstName: 'Maria',
    lastName: 'Silva',
    email: 'maria@empresa.com.br',
    whatsappE164: '+5511912345678',
    companyName: 'Empresa Ltda',
    areaOfExpertise: 'technology',
    areaOfExpertiseOther: null,
    jobTitle: null,
    companySize: null,
    companyWebsite: null,
    message: null,
    marketingOptIn: false,
    ...overrides,
  };
}

export function anInboundCommand(
  overrides: Partial<RegisterInboundLeadCommand> = {},
): RegisterInboundLeadCommand {
  return {
    workspaceId: WORKSPACE_ID,
    submissionId: '00000000-0000-7000-8000-00000000aa01' as SubmissionId,
    occurredAt: new Date('2026-11-03T12:00:00.000Z'),
    profile: anInboundProfile(),
    attribution: NO_ATTRIBUTION,
    correlationId: CORRELATION_ID,
    ...overrides,
  };
}

/** The crm use case wired to in-memory ports that share one fake unit of work. */
export function createCrmHarness() {
  const log = new CallLog();
  const registry = new TransactionRegistry();
  const leads = new FakeLeadRepository(registry, log);
  const activities = new FakeLeadActivityRepository(registry, log);
  const icp = new FakeIcpSettingsProvider();
  const ids = new SequentialIdGenerator();
  const unitOfWork = new FakeUnitOfWork(registry, [leads, activities], log);
  const registerInboundLead: RegisterInboundLead = createRegisterInboundLead({
    leads,
    activities,
    icp,
    ids,
  });

  /** Registers one submission in its own transaction (what SubmitLead does inside its own). */
  const register = (
    command: RegisterInboundLeadCommand = anInboundCommand(),
  ): Promise<RegisterInboundLeadResult> =>
    unitOfWork.run(command.workspaceId, (tx: Transaction) => registerInboundLead(tx, command));

  return { log, registry, leads, activities, icp, ids, unitOfWork, registerInboundLead, register };
}
