import { Hono } from 'hono';
import { staffSessionOf } from '#/platform/auth/staff-guards.ts';
import { requireRole, type StaffEnv, type StaffGuards } from '#/platform/auth/staff.ts';
import type { GetStaffProfile, ListStaffMembers } from '#/modules/crm/application/staff-session.ts';

export interface CrmStaffRoutesDependencies {
  readonly guards: StaffGuards;
  readonly getStaffProfile: GetStaffProfile;
  readonly listStaffMembers: ListStaffMembers;
}

/**
 * `GET /v1/crm/me` and `GET /v1/crm/members` (contract tag `crm-session`). Thin on purpose: guards, one use
 * case, response. Both are open to every workspace role (`x-roles`), read bucket, fail-open.
 * Paths are absolute: mount with `app.route('/', routes)`.
 */
export function createCrmStaffRoutes(deps: CrmStaffRoutesDependencies): Hono<StaffEnv> {
  const routes = new Hono<StaffEnv>();
  const everyRole = requireRole('owner', 'admin', 'sales', 'viewer');
  const guards = [
    deps.guards.authenticate,
    deps.guards.rateLimit('read', 'open'),
    everyRole,
  ] as const;

  routes.get('/v1/crm/me', ...guards, async (c) => {
    const staff = c.get('staff');
    const session = staffSessionOf(staff);
    if (session === undefined) {
      // Unreachable behind `authenticate`; a principal built elsewhere has no verified e-mail to show.
      throw new Error('staff principal without session facts');
    }
    const profile = await deps.getStaffProfile({
      userId: staff.userId,
      workspaceId: staff.workspaceId,
      role: staff.role,
      displayName: staff.displayName,
      email: session.email,
      aal: staff.aal,
      mfaVerifiedAt: staff.mfaVerifiedAt,
    });
    return c.json({
      user_id: profile.userId,
      email: profile.email,
      display_name: profile.displayName,
      role: profile.role,
      workspace: { id: profile.workspaceId, name: profile.workspaceName },
      aal: profile.aal,
      mfa_verified_at: profile.mfaVerifiedAt === null ? null : profile.mfaVerifiedAt.toISOString(),
    });
  });

  routes.get('/v1/crm/members', ...guards, async (c) => {
    const members = await deps.listStaffMembers(c.get('staff').workspaceId);
    return c.json({
      items: members.map((member) => ({
        user_id: member.userId,
        display_name: member.displayName,
        role: member.role,
        active: member.active,
      })),
    });
  });

  return routes;
}
