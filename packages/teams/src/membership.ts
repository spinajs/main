import { principalKey } from '@spinajs/authz';
import type { PrincipalRef } from '@spinajs/authz';
import { AssignmentStore, MembershipStore, parsePrincipalSubjectKey, parseSetKey, subjectKeyOf } from '@spinajs/authz-rbac';
import type { AssignmentSubject, SetSubject } from '@spinajs/authz-rbac';
import { InvalidOperation } from '@spinajs/exceptions';

import { GROUP_MEMBER_ROLE, GROUP_TYPE, TEAM_MEMBER_ROLE, TEAM_TYPE } from './api.js';
import type { GroupView, PrincipalTeams, Teammate, Teammates, TeamView } from './api.js';
import { asSystem, domainContainer } from './host.js';
import { Group } from './models/Group.js';
import { Team } from './models/Team.js';
import { teamRef } from './refs.js';
import { toGroupView, toTeamView } from './views.js';

const byName = (a: { name: string; id: string }, b: { name: string; id: string }) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

async function stores(op: string): Promise<{ memberships: MembershipStore; assignments: AssignmentStore }> {
  const container = await domainContainer();
  if (!container.hasRegistered(MembershipStore) || !container.hasRegistered(AssignmentStore)) {
    throw new InvalidOperation(`@spinajs/teams: ${op} needs the RBAC AssignmentStore and MembershipStore of the teams domain (authz.rbac.stores)`);
  }
  return { memberships: (await container.resolve(MembershipStore)) as MembershipStore, assignments: (await container.resolve(AssignmentStore)) as AssignmentStore };
}

/**
 * Teams design §7 `teamsOf`: the sets the principal belongs to (closure, so nested groups and sub-teams count) and the
 * roles it or those sets hold at team and group scopes. One closure read and one assignment read.
 */
export async function principalTeams(principal: PrincipalRef, now: Date = new Date()): Promise<PrincipalTeams> {
  const { memberships, assignments } = await stores('teamsOf');
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

/**
 * Teams design §7 `teammatesOf`: per team of `principalTeams`, the principals holding one of `roles` at the team, on a
 * row of their own or as members of a holding set (the closure, so nested groups and sub-teams count).
 */
export async function principalTeammates(principal: PrincipalRef, roles: readonly string[], now: Date = new Date()): Promise<readonly Teammates[]> {
  const { teams } = await principalTeams(principal, now);
  if (teams.length === 0) return Object.freeze([]);
  const { memberships, assignments } = await stores('teammatesOf');
  const me = principalKey(principal);
  // Sub-teams and groups often hold roles at several teams of the principal: each set is expanded once.
  const expanded = new Map<string, Promise<readonly string[]>>();
  const membersOf = (setKey: string) => {
    let members = expanded.get(setKey);
    if (!members) expanded.set(setKey, (members = memberships.membersOf(setKey, now)));
    return members;
  };

  return Object.freeze(
    await Promise.all(
      teams.map(async (t): Promise<Teammates> => {
        const found = new Map<string, { subject: PrincipalRef; roles: Set<string> }>();
        const hold = (p: PrincipalRef | undefined, role: string) => {
          if (p === undefined || p.id === '*') return;
          const key = principalKey(p);
          if (key === me) return;
          const entry = found.get(key) ?? { subject: Object.freeze({ type: p.type, id: p.id }), roles: new Set<string>() };
          entry.roles.add(role);
          found.set(key, entry);
        };
        for (const role of roles) {
          for (const s of await assignments.holders(role, teamRef(t.id), now)) {
            if (!('set' in s)) hold(s, role);
            else for (const key of await membersOf(subjectKeyOf(s))) hold(parsePrincipalSubjectKey(key), role);
          }
        }
        const members = [...found].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, e]): Teammate => Object.freeze({ subject: e.subject, roles: Object.freeze([...e.roles].sort()) }));
        return Object.freeze({ teamId: t.id, members: Object.freeze(members) });
      }),
    ),
  );
}
