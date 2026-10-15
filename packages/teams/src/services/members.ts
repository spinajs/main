import type { Assignment, Principal, PrincipalRef, ResourceRef } from '@spinajs/authz';
import { AssignmentStore } from '@spinajs/authz-rbac';

import type { MemberEntry, Paged, Page, TeamSubject } from '../api.js';
import { asSystem, domainContainer, domainService } from '../host.js';
import { Group } from '../models/Group.js';
import { Team } from '../models/Team.js';
import { fromAssignmentSubject } from '../subjects.js';
import { readPage } from '../validate.js';

/** The assignments at `scope`, read as the actor (AuthzAdmin checks the `list.assignments` permission mapped for the scope type). */
export async function listMembers(actor: Principal, scope: ResourceRef, page?: Page): Promise<Paged<MemberEntry>> {
  const out = await (await domainService()).admin().list(actor, { kind: 'assignments', scope, page: readPage(page) });
  const items: MemberEntry[] = [];
  for (const a of out.items as Assignment[]) {
    const subject = fromAssignmentSubject(a.subject);
    if (subject) items.push(Object.freeze({ subject, role: a.role, assignmentId: a.id, expiresAt: a.expiresAt ?? null }));
  }
  return Object.freeze({ items: Object.freeze(items), total: out.total });
}

/** Whether `subject` holds `role` directly at `scope` (a live row of its own, not through a set). */
export async function holdsAt(subject: PrincipalRef, role: string, scope: ResourceRef): Promise<boolean> {
  const container = await domainContainer();
  if (!container.hasRegistered(AssignmentStore)) return false;
  const rows = await ((await container.resolve(AssignmentStore)) as AssignmentStore).forSubjects([subject], new Date());
  return rows.some((a) => a.role === role && a.scope.type === scope.type && a.scope.id === scope.id);
}

/** Why `s` is a member of the team through the team structure (teams design §3), or undefined. */
export async function structuralLink(teamId: string, s: TeamSubject, subTeamsInParent: boolean): Promise<string | undefined> {
  if ('group' in s) {
    const group = await asSystem(() => Group.where('id', s.group).first());
    if (group && group.team_id === teamId && !group.parent_id) return 'a top-level group of the team is a member through the team structure; move or delete the group instead';
  }
  if ('team' in s && subTeamsInParent) {
    const team = await asSystem(() => Team.where('id', s.team).first());
    if (team && team.parent_id === teamId) return 'a sub-team is a member of its parent through the team structure; move the sub-team instead';
  }
  return undefined;
}
