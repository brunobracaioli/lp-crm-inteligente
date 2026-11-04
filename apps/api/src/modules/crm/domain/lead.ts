import type { LeadId, SubmissionId, UserId, WorkspaceId } from '#/shared/ids.ts';
import type { AreaOfExpertise, AttributionSnapshot, CompanySize } from '#/shared/lead-profile.ts';
import { err, ok, type Result } from '#/shared/result.ts';
import {
  EMPTY_ATTRIBUTION,
  hasPaidOrigin,
  recordTouch,
  startAttribution,
} from '#/modules/crm/domain/attribution.ts';
import { domainError, type DomainError } from '#/modules/crm/domain/errors.ts';
import type { LeadEvent } from '#/modules/crm/domain/lead-events.ts';
import { scoreLead, type LeadScore } from '#/modules/crm/domain/lead-score.ts';
import type {
  LeadStage,
  LostReason,
  ScoreBand,
  ScoreContribution,
} from '#/modules/crm/domain/lead-types.ts';
import type { IcpProfile } from '#/modules/crm/domain/scoring-config.ts';
import { planStageChange, type Actor } from '#/modules/crm/domain/stage.ts';
import {
  CompanyProfile,
  Email,
  PersonName,
  PhoneE164,
} from '#/modules/crm/domain/value-objects.ts';

/**
 * Persisted state of the aggregate (`crm.leads`). Structurally identical to `LeadState` of the
 * application ports, which the domain cannot import.
 */
export interface LeadProps {
  readonly id: LeadId;
  readonly workspaceId: WorkspaceId;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly whatsappE164: string;
  readonly companyName: string;
  readonly areaOfExpertise: AreaOfExpertise;
  readonly areaOfExpertiseOther: string | null;
  readonly jobTitle: string | null;
  readonly companySize: CompanySize | null;
  readonly companyWebsite: string | null;
  readonly stage: LeadStage;
  readonly lostReason: LostReason | null;
  readonly score: number;
  readonly scoreBand: ScoreBand;
  readonly scoreBreakdown: readonly ScoreContribution[];
  readonly ownerUserId: UserId | null;
  readonly marketingOptIn: boolean;
  readonly submissionsCount: number;
  readonly firstTouch: AttributionSnapshot;
  readonly lastTouch: AttributionSnapshot;
  readonly firstSubmittedAt: Date;
  readonly lastSubmittedAt: Date;
  readonly anonymizedAt: Date | null;
  /** Optimistic lock; the repository bumps it on write, the aggregate never does. */
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Contact and company data of one submission (same shape as `InboundLeadProfile`). */
export interface InboundContact {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly whatsappE164: string;
  readonly companyName: string;
  readonly areaOfExpertise: string;
  readonly areaOfExpertiseOther: string | null;
  readonly jobTitle: string | null;
  readonly companySize: string | null;
  readonly companyWebsite: string | null;
  /** Feeds the intent score only; never stored on the lead. */
  readonly message: string | null;
  readonly marketingOptIn: boolean;
}

export interface SubmissionInput {
  readonly submissionId: SubmissionId;
  readonly occurredAt: Date;
  readonly contact: InboundContact;
  readonly attribution: AttributionSnapshot;
}

export interface NewLeadInput extends SubmissionInput {
  readonly id: LeadId;
  readonly workspaceId: WorkspaceId;
}

/** Result of a behaviour: the next immutable aggregate and the events it raised. */
export interface LeadChange {
  readonly lead: Lead;
  readonly events: readonly LeadEvent[];
}

export interface ChangeStageCommand {
  readonly to: LeadStage;
  readonly by: Actor;
  /** Required exactly when `to` is `lost`. */
  readonly lostReason?: string | null;
  readonly occurredAt: Date;
}

export interface AssignOwnerCommand {
  readonly ownerUserId: UserId | null;
  readonly by: Actor;
  readonly occurredAt: Date;
}

export interface AnonymizeCommand {
  readonly by: Actor;
  readonly occurredAt: Date;
}

/** Irreversible placeholders; `anon+<id>@anonymized.invalid` satisfies the e-mail CHECK (database §6). */
const ANONYMIZED_TEXT = 'Anonymized';
const ANONYMIZED_WHATSAPP = '+10000000000';

interface ValidatedContact {
  readonly email: Email;
  readonly whatsappE164: PhoneE164;
  readonly name: PersonName;
  readonly company: CompanyProfile;
}

function validateContact(contact: InboundContact): Result<ValidatedContact, DomainError> {
  const email = Email.parse(contact.email);
  if (!email.ok) {
    return email;
  }
  const whatsappE164 = PhoneE164.parse(contact.whatsappE164);
  if (!whatsappE164.ok) {
    return whatsappE164;
  }
  const name = PersonName.parse(contact.firstName, contact.lastName);
  if (!name.ok) {
    return name;
  }
  const company = CompanyProfile.parse({
    name: contact.companyName,
    area: contact.areaOfExpertise,
    areaOther: contact.areaOfExpertiseOther,
    size: contact.companySize,
    website: contact.companyWebsite,
    jobTitle: contact.jobTitle,
  });
  if (!company.ok) {
    return company;
  }
  return ok({
    email: email.value,
    whatsappE164: whatsappE164.value,
    name: name.value,
    company: company.value,
  });
}

/**
 * The Lead aggregate root (crm §3): one person per `(workspace, e-mail)`. Behaviour lives here —
 * submission folding with the attribution and score rules, the stage machine, ownership and
 * anonymization. Every method returns a new instance plus the events it raised; nothing mutates.
 */
export class Lead {
  readonly #props: LeadProps;

  private constructor(props: LeadProps) {
    this.#props = props;
  }

  /** Rebuilds the aggregate from persisted state (no validation: the database CHECKs ran). */
  static rehydrate(props: LeadProps): Lead {
    return new Lead(props);
  }

  /**
   * First submission of a person: creates the lead in stage `new` with `first_touch = last_touch`
   * and its score. The id is created by the caller (UUID v7, database §1).
   */
  static register(input: NewLeadInput, icp: IcpProfile | null): Result<LeadChange, DomainError> {
    const contact = validateContact(input.contact);
    if (!contact.ok) {
      return contact;
    }
    const { name, company } = contact.value;
    const attribution = startAttribution(input.attribution);
    const score = scoreLead(
      {
        companySize: company.size,
        areaOfExpertise: company.area,
        jobTitle: company.jobTitle,
        email: contact.value.email,
        message: input.contact.message,
        companyWebsite: company.website,
      },
      { submissionsCount: 1, paidOrigin: hasPaidOrigin(attribution) },
      icp,
    );
    const props: LeadProps = {
      id: input.id,
      workspaceId: input.workspaceId,
      firstName: name.first,
      lastName: name.last,
      email: contact.value.email,
      whatsappE164: contact.value.whatsappE164,
      companyName: company.name,
      areaOfExpertise: company.area,
      areaOfExpertiseOther: company.areaOther,
      jobTitle: company.jobTitle,
      companySize: company.size,
      companyWebsite: company.website,
      stage: 'new',
      lostReason: null,
      score: score.value,
      scoreBand: score.band,
      scoreBreakdown: score.breakdown,
      ownerUserId: null,
      marketingOptIn: input.contact.marketingOptIn,
      submissionsCount: 1,
      firstTouch: attribution.firstTouch,
      lastTouch: attribution.lastTouch,
      firstSubmittedAt: input.occurredAt,
      lastSubmittedAt: input.occurredAt,
      anonymizedAt: null,
      version: 1,
      createdAt: input.occurredAt,
      updatedAt: input.occurredAt,
    };
    const lead = new Lead(props);
    return ok({ lead, events: [lead.#submissionRegistered(input)] });
  }

  get id(): LeadId {
    return this.#props.id;
  }

  get workspaceId(): WorkspaceId {
    return this.#props.workspaceId;
  }

  get stage(): LeadStage {
    return this.#props.stage;
  }

  get scoreBand(): ScoreBand {
    return this.#props.scoreBand;
  }

  get version(): number {
    return this.#props.version;
  }

  get isAnonymized(): boolean {
    return this.#props.anonymizedAt !== null;
  }

  toProps(): LeadProps {
    return this.#props;
  }

  /**
   * Folds another submission of the same person into the lead (R1, R5): the latest non-empty
   * contact data wins, `first_touch` is preserved, `last_touch` is replaced, the counter grows and
   * the score is recomputed. Raises `ScoreChanged` when the band moves.
   */
  registerSubmission(
    input: SubmissionInput,
    icp: IcpProfile | null,
  ): Result<LeadChange, DomainError> {
    const current = this.#props;
    if (current.anonymizedAt !== null) {
      return err(domainError('lead_anonymized'));
    }
    const contact = validateContact(input.contact);
    if (!contact.ok) {
      return contact;
    }
    if (contact.value.email !== current.email) {
      return err(domainError('email_mismatch'));
    }
    const { name, company } = contact.value;
    const attribution = recordTouch(
      { firstTouch: current.firstTouch, lastTouch: current.lastTouch },
      input.attribution,
    );
    const submissionsCount = current.submissionsCount + 1;
    const merged = {
      jobTitle: company.jobTitle ?? current.jobTitle,
      companySize: company.size ?? current.companySize,
      companyWebsite: company.website ?? current.companyWebsite,
    };
    const score = scoreLead(
      {
        ...merged,
        areaOfExpertise: company.area,
        email: current.email,
        message: input.contact.message,
      },
      { submissionsCount, paidOrigin: hasPaidOrigin(attribution) },
      icp,
    );
    const next = new Lead({
      ...current,
      ...merged,
      firstName: name.first,
      lastName: name.last,
      whatsappE164: contact.value.whatsappE164,
      companyName: company.name,
      // Area and "other" travel together to keep the database CHECK true.
      areaOfExpertise: company.area,
      areaOfExpertiseOther: company.areaOther,
      marketingOptIn: input.contact.marketingOptIn,
      submissionsCount,
      lastTouch: attribution.lastTouch,
      lastSubmittedAt: input.occurredAt,
      updatedAt: input.occurredAt,
      ...scoreProps(score),
    });
    const events: LeadEvent[] = [next.#submissionRegistered(input)];
    if (score.band !== current.scoreBand) {
      events.push({
        type: 'ScoreChanged',
        leadId: current.id,
        occurredAt: input.occurredAt,
        previousBand: current.scoreBand,
        scoreBand: score.band,
        score: score.value,
      });
    }
    return ok({ lead: next, events });
  }

  /** Moves the lead through the pipeline of crm §4. */
  changeStage(command: ChangeStageCommand): Result<LeadChange, DomainError> {
    const current = this.#props;
    if (current.anonymizedAt !== null) {
      return err(domainError('lead_anonymized'));
    }
    const plan = planStageChange({
      from: current.stage,
      to: command.to,
      lostReason: command.lostReason ?? null,
      by: command.by,
    });
    if (!plan.ok) {
      return plan;
    }
    const next = new Lead({
      ...current,
      stage: plan.value.stage,
      lostReason: plan.value.lostReason,
      updatedAt: command.occurredAt,
    });
    return ok({
      lead: next,
      events: [
        {
          type: 'StageChanged',
          leadId: current.id,
          occurredAt: command.occurredAt,
          from: current.stage,
          to: plan.value.stage,
          lostReason: plan.value.lostReason,
          by: command.by,
        },
      ],
    });
  }

  /** Assigns (or clears) the owner. Re-assigning the same owner is a no-op without events. */
  assignOwner(command: AssignOwnerCommand): Result<LeadChange, DomainError> {
    const current = this.#props;
    if (current.anonymizedAt !== null) {
      return err(domainError('lead_anonymized'));
    }
    if (current.ownerUserId === command.ownerUserId) {
      return ok({ lead: this, events: [] });
    }
    const next = new Lead({
      ...current,
      ownerUserId: command.ownerUserId,
      updatedAt: command.occurredAt,
    });
    return ok({
      lead: next,
      events: [
        {
          type: 'OwnerAssigned',
          leadId: current.id,
          occurredAt: command.occurredAt,
          previousOwnerUserId: current.ownerUserId,
          ownerUserId: command.ownerUserId,
          by: command.by,
        },
      ],
    });
  }

  /**
   * LGPD erasure (irreversible): replaces the PII with fixed placeholders and clears the
   * attribution. Stage, score, owner and dates stay for metrics (database §6). The e-mail is
   * freed for a future lead because the unique index ignores anonymized rows.
   */
  anonymize(command: AnonymizeCommand): Result<LeadChange, DomainError> {
    const current = this.#props;
    if (current.anonymizedAt !== null) {
      return err(domainError('lead_anonymized'));
    }
    const next = new Lead({
      ...current,
      firstName: ANONYMIZED_TEXT,
      lastName: ANONYMIZED_TEXT,
      email: `anon+${current.id}@anonymized.invalid`,
      whatsappE164: ANONYMIZED_WHATSAPP,
      companyName: ANONYMIZED_TEXT,
      areaOfExpertiseOther: current.areaOfExpertiseOther === null ? null : ANONYMIZED_TEXT,
      jobTitle: null,
      companyWebsite: null,
      marketingOptIn: false,
      firstTouch: EMPTY_ATTRIBUTION,
      lastTouch: EMPTY_ATTRIBUTION,
      anonymizedAt: command.occurredAt,
      updatedAt: command.occurredAt,
    });
    return ok({
      lead: next,
      events: [
        {
          type: 'LeadAnonymized',
          leadId: current.id,
          occurredAt: command.occurredAt,
          by: command.by,
        },
      ],
    });
  }

  #submissionRegistered(input: SubmissionInput): LeadEvent {
    return {
      type: 'SubmissionRegistered',
      leadId: this.#props.id,
      occurredAt: input.occurredAt,
      submissionId: input.submissionId,
      score: this.#props.score,
      scoreBand: this.#props.scoreBand,
      submissionsCount: this.#props.submissionsCount,
    };
  }
}

function scoreProps(score: LeadScore): Pick<LeadProps, 'score' | 'scoreBand' | 'scoreBreakdown'> {
  return { score: score.value, scoreBand: score.band, scoreBreakdown: score.breakdown };
}
