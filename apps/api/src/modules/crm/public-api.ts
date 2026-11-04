/**
 * Public interface of the `crm` bounded context (crm §6). Other modules import ONLY this file.
 * Signatures frozen in Onda 0; implementations arrive in Onda 2 (use case) and Onda 4 (wiring).
 */
import type { ScoreBand } from '#/modules/crm/domain/lead-types.ts';
import type { CorrelationId, LeadId, SubmissionId, WorkspaceId } from '#/shared/ids.ts';
import type { AreaOfExpertise, AttributionSnapshot, CompanySize } from '#/shared/lead-profile.ts';
import type { Transaction } from '#/shared/unit-of-work.ts';

export type { LeadStage, LostReason, ScoreBand } from '#/modules/crm/domain/lead-types.ts';

/** Normalized submission data (no Turnstile token, no IP, no UA). Already validated at the edge. */
export interface InboundLeadProfile {
  readonly firstName: string;
  readonly lastName: string;
  /** Lowercase, trimmed. Dedupe key together with the workspace (R1). */
  readonly email: string;
  readonly whatsappE164: string;
  readonly companyName: string;
  readonly areaOfExpertise: AreaOfExpertise;
  readonly areaOfExpertiseOther: string | null;
  readonly jobTitle: string | null;
  readonly companySize: CompanySize | null;
  readonly companyWebsite: string | null;
  /** Used for the intent score only; persisted on the submission, not on the lead. */
  readonly message: string | null;
  readonly marketingOptIn: boolean;
}

export interface RegisterInboundLeadCommand {
  readonly workspaceId: WorkspaceId;
  readonly submissionId: SubmissionId;
  readonly occurredAt: Date;
  readonly profile: InboundLeadProfile;
  readonly attribution: AttributionSnapshot;
  readonly correlationId: CorrelationId;
}

export interface RegisterInboundLeadResult {
  readonly leadId: LeadId;
  /** Internal only — must never reach the HTTP response (anti-enumeration, R2). */
  readonly isNew: boolean;
  readonly scoreBand: ScoreBand;
}

/**
 * Creates or updates the lead inside the caller's transaction (same commit as the submission).
 * Writes the `submission_received` activity and recalculates the score.
 */
export type RegisterInboundLead = (
  tx: Transaction,
  command: RegisterInboundLeadCommand,
) => Promise<RegisterInboundLeadResult>;

/** Factory for the composition root (Onda 4); callers still depend only on the types above. */
export {
  createRegisterInboundLead,
  type RegisterInboundLeadDependencies,
} from '#/modules/crm/application/register-inbound-lead.ts';
