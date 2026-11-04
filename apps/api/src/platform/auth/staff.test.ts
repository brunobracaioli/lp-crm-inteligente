import { describe, expect, it } from 'vitest';
import type { UserId, WorkspaceId } from '#/shared/ids.ts';
import { assertRecentMfa, assertRole, type StaffPrincipal } from './staff.ts';

const NOW = new Date('2026-11-04T12:00:00.000Z');

function principal(overrides: Partial<StaffPrincipal> = {}): StaffPrincipal {
  return {
    userId: '0196f1a0-0000-7000-8000-000000000001' as UserId,
    workspaceId: '0196f1a0-0000-7000-8000-000000000002' as WorkspaceId,
    role: 'admin',
    displayName: 'Admin',
    aal: 'aal2',
    mfaVerifiedAt: new Date(NOW.getTime() - 60_000),
    ...overrides,
  };
}

describe('assertRole', () => {
  it('accepts an allowed role', () => {
    expect(() => {
      assertRole(principal({ role: 'sales' }), ['owner', 'admin', 'sales']);
    }).not.toThrow();
  });

  it('rejects any other role with 403 forbidden', () => {
    expect(() => {
      assertRole(principal({ role: 'viewer' }), ['owner', 'admin']);
    }).toThrow(expect.objectContaining({ status: 403, code: 'forbidden' }));
  });
});

describe('assertRecentMfa', () => {
  it('accepts AAL2 verified within the window', () => {
    expect(() => {
      assertRecentMfa(principal(), NOW);
    }).not.toThrow();
  });

  it('requires MFA when the session is AAL1', () => {
    expect(() => {
      assertRecentMfa(principal({ aal: 'aal1', mfaVerifiedAt: null }), NOW);
    }).toThrow(expect.objectContaining({ status: 403, code: 'mfa_required' }));
  });

  it('requires MFA when AAL2 carries no MFA timestamp', () => {
    expect(() => {
      assertRecentMfa(principal({ mfaVerifiedAt: null }), NOW);
    }).toThrow(expect.objectContaining({ code: 'mfa_required' }));
  });

  it('asks for reauthentication when the MFA is older than 300 s', () => {
    const stale = principal({ mfaVerifiedAt: new Date(NOW.getTime() - 301_000) });
    expect(() => {
      assertRecentMfa(stale, NOW);
    }).toThrow(expect.objectContaining({ status: 403, code: 'reauthentication_required' }));
  });

  it('accepts exactly 300 s', () => {
    const edge = principal({ mfaVerifiedAt: new Date(NOW.getTime() - 300_000) });
    expect(() => {
      assertRecentMfa(edge, NOW);
    }).not.toThrow();
  });

  it('rejects an MFA timestamp far in the future', () => {
    const future = principal({ mfaVerifiedAt: new Date(NOW.getTime() + 120_000) });
    expect(() => {
      assertRecentMfa(future, NOW);
    }).toThrow(expect.objectContaining({ code: 'reauthentication_required' }));
  });
});
