import type { StoredNote } from '#/modules/crm/application/commands/ports.ts';
import type { LeadState } from '#/modules/crm/application/ports.ts';

/** Wire shapes of the staff write responses (contract `LeadSummary` and `LeadActivity`). */

export interface LeadSummaryView {
  readonly id: string;
  readonly first_name: string;
  readonly last_name: string;
  readonly email: string;
  readonly company_name: string;
  readonly job_title: string | null;
  readonly area_of_expertise: string;
  readonly company_size: string | null;
  readonly stage: string;
  readonly lost_reason: string | null;
  readonly score: number;
  readonly score_band: string;
  readonly owner_user_id: string | null;
  readonly submissions_count: number;
  readonly first_submitted_at: string;
  readonly last_submitted_at: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly anonymized_at: string | null;
  readonly version: number;
}

export function leadSummaryView(lead: LeadState): LeadSummaryView {
  return {
    id: lead.id,
    first_name: lead.firstName,
    last_name: lead.lastName,
    email: lead.email,
    company_name: lead.companyName,
    job_title: lead.jobTitle,
    area_of_expertise: lead.areaOfExpertise,
    company_size: lead.companySize,
    stage: lead.stage,
    lost_reason: lead.lostReason,
    score: lead.score,
    score_band: lead.scoreBand,
    owner_user_id: lead.ownerUserId,
    submissions_count: lead.submissionsCount,
    first_submitted_at: lead.firstSubmittedAt.toISOString(),
    last_submitted_at: lead.lastSubmittedAt.toISOString(),
    created_at: lead.createdAt.toISOString(),
    updated_at: lead.updatedAt.toISOString(),
    anonymized_at: lead.anonymizedAt === null ? null : lead.anonymizedAt.toISOString(),
    version: lead.version,
  };
}

export interface NoteActivityView {
  readonly id: string;
  readonly type: 'note_added';
  readonly actor_type: 'user';
  readonly actor_id: string | null;
  readonly created_at: string;
  readonly data: { readonly body: string };
}

/** The note as the contract's `LeadActivity`; the body is untrusted text, rendered only as text. */
export function noteActivityView(note: StoredNote): NoteActivityView {
  return {
    id: note.id,
    type: 'note_added',
    actor_type: 'user',
    actor_id: note.actorId,
    created_at: note.createdAt.toISOString(),
    data: { body: note.body },
  };
}
