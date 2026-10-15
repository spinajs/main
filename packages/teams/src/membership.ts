import type { AssignmentSubject, PrincipalRef } from '@spinajs/authz';
import { AssignmentStore, MembershipStore, parseSetKey, subjectKeyOf } from '@spinajs/authz-rbac';
import type { SetSubject } from '@spinajs/authz-rbac';
import { InvalidOperation } from '@spinajs/exceptions';

import { GROUP_MEMBER_ROLE, GROUP_TYPE, TEAM_MEMBER_ROLE, TEAM_TYPE } from './api.js';
import type { GroupView, PrincipalTeams, TeamView } from './api.js';
import { asSystem, domainContainer } from './host.js';
import { Group } from './models/Group.js';
import { Team } from './models/Team.js';
import { toGroupView, toTeamView } from './views.js';

const byName = (a: { name: string; id: string }, b: { name: string; id: string }) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * Teams design §7 `teamsOf`: the sets the principal belongs to (closure, so nested groups and sub-teams count) and the
 * roles it or those sets hold at team and group scopes. One closure read and one assignment read.
 */
export async function principalTeams(principal: PrincipalRef, now: Date = new Date()): Promise<PrincipalTeams> {
  const container = await domainContainer();
  if (!container.hasRegistered(MembershipStore) || !container.hasRegistered(AssignmentStore)) {
    throw new InvalidOperation('@spinajs/teams: teamsOf needs the RBAC AssignmentStore and MembershipStore of the teams domain (authz.rbac.stores)');
  }
  const memberships = (await container.resolve(MembershipStore)) as MembershipStore;
  const assignments = (await container.resolve(AssignmentStore)) as AssignmentStore;
  const me: PrincipalRef = { type: principal.type, id: principal.id };

  const sets = (await memberships.setsOf([subjectKeyOf(me)], now)).map((m) => parseSetKey(m.setKey)).filter((s): s is SetSubject => s !== undefined);
  const roles = new Map<string, Set<string>>();
  const hold = (type: string, id: string, role?: string) => {
    const key = `${type}:${id}`;
    const held = roles.get(key) ?? new Set<string>();
    if (role !== undefined) held.add(role);
    roles.set(key, held);
  };
  for (const { set } of sets) {
    const id = set.scope.id;
    if (typeof id !== 'string') continue;
    if ((set.role === TEAM_MEMBER_ROLE && set.scope.type === TEAM_TYPE) || (set.role === GROUP_MEMBER_ROLE && set.scope.type === GROUP_TYPE)) hold(set.scope.type, id);
  }
  const subjects: AssignmentSubject[] = [me, ...sets];
  for (const a of await assignments.forSubjects(subjects, now)) {
    if ((a.scope.type === TEAM_TYPE || a.scope.type === GROUP_TYPE) && typeof a.scope.id === 'string') hold(a.scope.type, a.scope.id, a.role);
  }

  const idsOf = (type: string) => [...roles.keys()].filter((k) => k.startsWith(`${type}:`)).map((k) => k.slice(type.length + 1));
  const groupIds = idsOf(GROUP_TYPE);
  const groups = groupIds.length > 0 ? await asSystem(async () => (await Group.query().whereIn('id', groupIds)) as Group[]) : [];
  const teamIds = [...new Set([...idsOf(TEAM_TYPE), ...groups.map((g) => g.team_id)])];
  const teams = teamIds.length > 0 ? await asSystem(async () => (await Team.query().whereIn('id', teamIds).whereNull('deleted_at')) as Team[]) : [];
  const live = new Set(teams.map((t) => t.id));
  const rolesAt = (type: string, id: string) => Object.freeze([...(roles.get(`${type}:${id}`) ?? [])].sort());

  return Object.freeze({
    teams: Object.freeze(
      teams
        .filter((t) => roles.has(`${TEAM_TYPE}:${t.id}`))
        .map((t): TeamView & { roles: readonly string[] } => Object.freeze({ ...toTeamView(t), roles: rolesAt(TEAM_TYPE, t.id) }))
        .sort(byName),
    ),
    groups: Object.freeze(
      groups
        .filter((g) => live.has(g.team_id))
        .map((g): GroupView & { roles: readonly string[] } => Object.freeze({ ...toGroupView(g), roles: rolesAt(GROUP_TYPE, g.id) }))
        .sort(byName),
    ),
  });
}
