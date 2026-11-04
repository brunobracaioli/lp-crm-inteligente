import type { UserId, WorkspaceId } from '#/shared/ids.ts';

/**
 * Session reads for the CRM web (contract `GET /v1/crm/me` and `GET /v1/crm/members`). The caller (the route) has
 * already authenticated the staff member and resolved the workspace from `core.workspace_members`; nothing here
 * accepts a workspace or user id from the client.
 */

export type StaffMemberRole = 'owner' | 'admin' | 'sales' | 'viewer';

/** Contract `StaffMemberList.maxItems`. */
export const MAX_LISTED_MEMBERS = 200;

export interface StaffMemberRecord {
  readonly userId: UserId;
  readonly displayName: string;
  readonly role: StaffMemberRole;
  readonly active: boolean;
}

/** Read port over `core.workspaces` / `core.workspace_members`, always scoped to one workspace. */
export interface StaffDirectory {
  /** Name of the workspace, or null if the row is not visible (broken membership; never expected). */
  workspaceName(workspaceId: WorkspaceId): Promise<string | null>;
  /** Active and inactive members (a lead may keep an owner that was later deactivated), at most 200. */
  listMembers(workspaceId: WorkspaceId): Promise<readonly StaffMemberRecord[]>;
}

export interface StaffProfileInput {
  readonly userId: UserId;
  readonly workspaceId: WorkspaceId;
  readonly role: StaffMemberRole;
  readonly displayName: string;
  readonly email: string;
  readonly aal: 'aal1' | 'aal2';
  readonly mfaVerifiedAt: Date | null;
}

export interface StaffProfile extends StaffProfileInput {
  readonly workspaceName: string;
}

export type GetStaffProfile = (input: StaffProfileInput) => Promise<StaffProfile>;

export function createGetStaffProfile(directory: StaffDirectory): GetStaffProfile {
  return async (input) => {
    const workspaceName = await directory.workspaceName(input.workspaceId);
    if (workspaceName === null) {
      // A membership whose workspace is invisible violates the foreign key; surface it as a server fault.
      throw new Error('workspace of an active membership is not readable');
    }
    return { ...input, workspaceName };
  };
}

export type ListStaffMembers = (workspaceId: WorkspaceId) => Promise<readonly StaffMemberRecord[]>;

export function createListStaffMembers(directory: StaffDirectory): ListStaffMembers {
  return (workspaceId) => directory.listMembers(workspaceId);
}
