import { describe, expect, it } from 'vitest';
import { createKeyedMac } from '#/platform/crypto/derived-key.ts';
import type { LeadId, UserId, WorkspaceId } from '#/shared/ids.ts';
import {
  ERASURE_CATEGORIES,
  fingerprintOf,
  issuePlan,
  PLAN_EXPIRY_GRID_SECONDS,
  PLAN_TTL_SECONDS,
  verifyPlan,
  type PlanSubject,
} from '#/modules/crm/application/commands/anonymization-plan.ts';

const mac = createKeyedMac(Buffer.alloc(32, 3).toString('base64'), 'crm-plan-v1');
const cursorMac = createKeyedMac(Buffer.alloc(32, 3).toString('base64'), 'crm-cursor-v1');
const NOW = new Date('2026-11-04T10:00:17.000Z');

const subject: PlanSubject = {
  workspaceId: '00000000-0000-7000-8000-00000000a001' as WorkspaceId,
  leadId: '00000000-0000-7000-8000-000000000001' as LeadId,
  version: 3,
  userId: '00000000-0000-7000-8000-0000000000e2' as UserId,
  fingerprint: fingerprintOf([{ category: 'activity_notes', count: 1 }]),
};

const later = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1000);

describe('anonymization plan', () => {
  it('issues a 43-character base64url hash that expires on the grid within the TTL', () => {
    const plan = issuePlan(mac, subject, NOW);

    expect(plan.planHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(plan.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
    expect(plan.expiresAt.getTime()).toBeLessThanOrEqual(NOW.getTime() + PLAN_TTL_SECONDS * 1000);
    expect((plan.expiresAt.getTime() / 1000) % PLAN_EXPIRY_GRID_SECONDS).toBe(0);
  });

  it('verifies until the announced expiry, then not', () => {
    const plan = issuePlan(mac, subject, NOW);
    const remaining = (plan.expiresAt.getTime() - NOW.getTime()) / 1000;

    expect(verifyPlan(mac, subject, plan.planHash, NOW)).toBe(true);
    expect(verifyPlan(mac, subject, plan.planHash, later(remaining - 1))).toBe(true);
    expect(verifyPlan(mac, subject, plan.planHash, later(remaining))).toBe(false);
    expect(verifyPlan(mac, subject, plan.planHash, later(PLAN_TTL_SECONDS * 2))).toBe(false);
  });

  it.each([
    ['another version', { ...subject, version: 4 }],
    ['another user', { ...subject, userId: '00000000-0000-7000-8000-0000000000e3' as UserId }],
    ['another lead', { ...subject, leadId: '00000000-0000-7000-8000-000000000002' as LeadId }],
    [
      'another workspace',
      { ...subject, workspaceId: '00000000-0000-7000-8000-00000000b001' as WorkspaceId },
    ],
    ['another inventory', { ...subject, fingerprint: fingerprintOf([]) }],
  ])('rejects the hash for %s', (_label, other) => {
    const plan = issuePlan(mac, subject, NOW);
    expect(verifyPlan(mac, other, plan.planHash, NOW)).toBe(false);
  });

  it('rejects a hash made with another derived key (a cursor MAC is never a plan hash)', () => {
    const forged = issuePlan(cursorMac, subject, NOW);
    expect(verifyPlan(mac, subject, forged.planHash, NOW)).toBe(false);
  });

  it('rejects empty and garbage hashes', () => {
    expect(verifyPlan(mac, subject, '', NOW)).toBe(false);
    expect(verifyPlan(mac, subject, 'x'.repeat(43), NOW)).toBe(false);
  });

  it('fingerprints the inventory deterministically and sensitively', () => {
    const a = fingerprintOf(ERASURE_CATEGORIES.map((category) => ({ category, count: 1 })));
    const b = fingerprintOf(ERASURE_CATEGORIES.map((category) => ({ category, count: 1 })));
    const c = fingerprintOf(ERASURE_CATEGORIES.map((category) => ({ category, count: 2 })));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
