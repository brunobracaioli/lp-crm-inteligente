import type { KeyedMac } from '#/platform/crypto/derived-key.ts';
import { sha256Hex } from '#/platform/crypto/hashing.ts';
import { timingSafeEqualText } from '#/platform/crypto/safe-compare.ts';
import type { LeadState } from '#/modules/crm/application/ports.ts';
import type { ErasureInventory } from '#/modules/crm/application/commands/ports.ts';
import type { LeadId, UserId, WorkspaceId } from '#/shared/ids.ts';

/**
 * The anonymization plan (crm §7, contract `anonymizeLead`): what the preview showed, and the
 * `plan_hash` that binds the confirmation to it. The hash is a stateless keyed MAC (key derived
 * from the pepper, label `crm-plan-v1`) over workspace, lead, version, requesting user, a
 * fingerprint of the erasure inventory and an expiry. Nothing is stored server-side.
 */

export const PLAN_TTL_SECONDS = 600;
/**
 * The expiry is part of the MAC but not of the request, so it is quantized: the verifier tries every
 * grid point still in the future instead of needing the exact instant the preview was issued.
 */
export const PLAN_EXPIRY_GRID_SECONDS = 60;

const MS_PER_SECOND = 1000;
const ACTION = 'anonymize';

export const WILL_KEEP = [
  'identifiers',
  'stage_and_score',
  'timestamps',
  'consent_history',
  'audit_trail',
] as const;

export const ERASURE_CATEGORIES = [
  'lead_contact_fields',
  'lead_company_fields',
  'attribution_snapshots',
  'submission_fields',
  'submission_messages',
  'submission_tracking_identifiers',
  'submission_ip_and_user_agent',
  'activity_notes',
] as const;
export type ErasureCategory = (typeof ERASURE_CATEGORIES)[number];

export interface ErasureItem {
  readonly category: ErasureCategory;
  readonly count: number;
}

const CONTACT_FIELDS = 4; // first name, last name, e-mail, WhatsApp

function companyFieldCount(lead: LeadState): number {
  return [lead.companyName, lead.jobTitle, lead.companyWebsite, lead.areaOfExpertiseOther].filter(
    (value) => value !== null,
  ).length;
}

function touchCount(lead: LeadState): number {
  return [lead.firstTouch, lead.lastTouch].filter((touch) =>
    Object.values(touch).some((value) => value !== null),
  ).length;
}

/** What `crm.anonymize_lead` erases, in the contract's category order. */
export function erasureItems(lead: LeadState, inventory: ErasureInventory): readonly ErasureItem[] {
  return [
    { category: 'lead_contact_fields', count: CONTACT_FIELDS },
    { category: 'lead_company_fields', count: companyFieldCount(lead) },
    { category: 'attribution_snapshots', count: touchCount(lead) },
    { category: 'submission_fields', count: inventory.submissionFields },
    { category: 'submission_messages', count: inventory.submissionMessages },
    {
      category: 'submission_tracking_identifiers',
      count: inventory.submissionTrackingIdentifiers,
    },
    { category: 'submission_ip_and_user_agent', count: inventory.submissionIpAndUserAgent },
    { category: 'activity_notes', count: inventory.activityNotes },
  ];
}

export function fingerprintOf(items: readonly ErasureItem[]): string {
  return sha256Hex(items.map((item) => `${item.category}=${String(item.count)}`).join(';'));
}

export interface PlanSubject {
  readonly workspaceId: WorkspaceId;
  readonly leadId: LeadId;
  readonly version: number;
  readonly userId: UserId;
  readonly fingerprint: string;
}

function macInput(subject: PlanSubject, expiresAtEpochSeconds: number): string {
  return [
    ACTION,
    subject.workspaceId,
    subject.leadId,
    String(subject.version),
    subject.userId,
    subject.fingerprint,
    String(expiresAtEpochSeconds),
  ].join('|');
}

export interface IssuedPlan {
  readonly planHash: string;
  readonly expiresAt: Date;
}

export function issuePlan(mac: KeyedMac, subject: PlanSubject, now: Date): IssuedPlan {
  const horizon = Math.floor(now.getTime() / MS_PER_SECOND) + PLAN_TTL_SECONDS;
  const expiresAtSeconds =
    Math.floor(horizon / PLAN_EXPIRY_GRID_SECONDS) * PLAN_EXPIRY_GRID_SECONDS;
  return {
    planHash: mac(macInput(subject, expiresAtSeconds)),
    expiresAt: new Date(expiresAtSeconds * MS_PER_SECOND),
  };
}

/** True when `planHash` was issued for exactly this subject and has not expired. */
export function verifyPlan(
  mac: KeyedMac,
  subject: PlanSubject,
  planHash: string,
  now: Date,
): boolean {
  const nowSeconds = Math.floor(now.getTime() / MS_PER_SECOND);
  const firstPoint =
    (Math.floor(nowSeconds / PLAN_EXPIRY_GRID_SECONDS) + 1) * PLAN_EXPIRY_GRID_SECONDS;
  const lastPoint = nowSeconds + PLAN_TTL_SECONDS;
  let valid = false;
  // Every candidate is evaluated (no early exit) so timing does not reveal which expiry matched.
  for (let point = firstPoint; point <= lastPoint; point += PLAN_EXPIRY_GRID_SECONDS) {
    if (timingSafeEqualText(mac(macInput(subject, point)), planHash)) {
      valid = true;
    }
  }
  return valid;
}
