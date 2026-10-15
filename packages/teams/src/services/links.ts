import type { AssignmentSubject, AuthzCommand, ResourceRef } from '@spinajs/authz';

import { GROUP_MEMBER_ROLE, TEAM_MEMBER_ROLE } from '../api.js';
import { groupRef, teamRef } from '../refs.js';
import { groupSet, teamSet } from '../subjects.js';

export const link = (subject: AssignmentSubject, role: string, scope: ResourceRef): AuthzCommand => ({ kind: 'assignment.grant', subject, role, scope });

/** Every role `subject` holds at `scope`: a moved set keeps nothing at its old place. */
export const unlink = (subject: AssignmentSubject, scope: ResourceRef): AuthzCommand => ({ kind: 'assignment.revokeWhere', scope, subject });

export const linkSubTeam = (teamId: string, parentId: string): AuthzCommand => link(teamSet(teamId), TEAM_MEMBER_ROLE, teamRef(parentId));
export const unlinkSubTeam = (teamId: string, parentId: string): AuthzCommand => unlink(teamSet(teamId), teamRef(parentId));

/** Teams design §3: a nested group joins its outer group's set, a top-level group its team's set. */
export function groupLinkTarget(g: { readonly team_id: string; readonly parent_id: string | null }): { role: string; scope: ResourceRef } {
  return g.parent_id ? { role: GROUP_MEMBER_ROLE, scope: groupRef(g.parent_id) } : { role: TEAM_MEMBER_ROLE, scope: teamRef(g.team_id) };
}

export const linkGroup = (g: { readonly id: string; readonly team_id: string; readonly parent_id: string | null }): AuthzCommand => {
  const target = groupLinkTarget(g);
  return link(groupSet(g.id), target.role, target.scope);
};

export const unlinkGroup = (g: { readonly id: string; readonly team_id: string; readonly parent_id: string | null }): AuthzCommand => unlink(groupSet(g.id), groupLinkTarget(g).scope);

export const archivedAttribute = (teamId: string, archived: boolean): AuthzCommand => ({ kind: 'scope.setAttributes', scope: teamRef(teamId), patch: { archived } });
