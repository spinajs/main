import type { AssignmentSubject } from '@spinajs/authz';
import { InvalidArgument } from '@spinajs/exceptions';

import { GROUP_MEMBER_ROLE, GROUP_TYPE, TEAM_MEMBER_ROLE, TEAM_TYPE } from './api.js';
import type { TeamSubject } from './api.js';
import { liveGroup, liveTeam } from './lookup.js';

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';

export const groupSet = (groupId: string): AssignmentSubject => ({ set: { role: GROUP_MEMBER_ROLE, scope: { type: GROUP_TYPE, id: groupId } } });
export const teamSet = (teamId: string): AssignmentSubject => ({ set: { role: TEAM_MEMBER_ROLE, scope: { type: TEAM_TYPE, id: teamId } } });

export function readSubject(v: unknown, field = 'subject'): TeamSubject {
  const bad = () => new InvalidArgument(`${field} must be { type, id }, { group } or { team }`, field);
  if (!isRecord(v)) throw bad();
  const keys = Object.keys(v).sort().join(',');
  if (keys === 'group' && nonEmpty(v.group)) return { group: v.group };
  if (keys === 'team' && nonEmpty(v.team)) return { team: v.team };
  if (keys === 'id,type' && nonEmpty(v.type) && nonEmpty(v.id)) return { type: v.type, id: v.id };
  throw bad();
}

export function toAssignmentSubject(s: TeamSubject): AssignmentSubject {
  if ('group' in s) return groupSet(s.group);
  if ('team' in s) return teamSet(s.team);
  return { type: s.type, id: s.id };
}

/** The TeamSubject of an assignment subject; undefined for sets teams do not model. */
export function fromAssignmentSubject(s: AssignmentSubject): TeamSubject | undefined {
  if (!('set' in s)) return { type: s.type, id: s.id };
  const { role, scope } = s.set;
  if (!nonEmpty(scope.id)) return undefined;
  if (role === GROUP_MEMBER_ROLE && scope.type === GROUP_TYPE) return { group: scope.id };
  if (role === TEAM_MEMBER_ROLE && scope.type === TEAM_TYPE) return { team: scope.id };
  return undefined;
}

export function subjectLabel(s: TeamSubject): string {
  if ('group' in s) return `${GROUP_TYPE}:${s.group}`;
  if ('team' in s) return `${TEAM_TYPE}:${s.team}`;
  return `${s.type}:${s.id}`;
}

/** `group:<id>` and `team:<id>` name member sets; any other `type:id` is a principal. */
export function parseSubjectLabel(label: string): TeamSubject {
  const at = typeof label === 'string' ? label.indexOf(':') : -1;
  if (at <= 0 || at === label.length - 1) throw new InvalidArgument('subject must be <type>:<id>', 'subject');
  const type = label.slice(0, at);
  const id = label.slice(at + 1);
  if (type === GROUP_TYPE) return { group: id };
  if (type === TEAM_TYPE) return { team: id };
  return { type, id };
}

/** Groups and teams named as subjects must be live; principals are not looked up. */
export async function assertSubjectExists(s: TeamSubject): Promise<void> {
  if ('group' in s) await liveGroup(s.group, 'subject.group');
  else if ('team' in s) await liveTeam(s.team, 'subject.team');
}
