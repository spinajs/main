import type { Assignment, AssignmentSubject, DecisionRequest, EvaluationContext } from '@spinajs/authz';

import { subjectKey } from '../assignments.js';
import { withinCeiling } from '../ceiling.js';
import type { LiveAssignment, RbacExtension, RbacExtensionFactory, RbacInput, RbacSources, RbacState, RbacStep } from '../evaluate.js';
import { memberKeysOf, parseSetKey } from './keys.js';
import { isSetResolver } from './resolver.js';
import type { SetSubject } from './resolver.js';

type Maybe<T> = T | PromiseLike<T>;

/** A set the principal reaches only through other sets, and when that membership ends. */
export interface NestedSet {
  readonly subject: SetSubject;
  readonly expiresAt?: Date;
}

/**
 * Subject sets (design §6.1.3, §4.3): after the principal's own rows are read, the sets they make it a member
 * of (one level, with the via role and expiry) and, with a MembershipStore, the sets it reaches through other
 * sets are read too, in one more store read, and join `subjects` and `assignments`. Only a resolver with
 * `memberships` (RbacSubjectResolver, the default) names them.
 */
export class SetsExtension implements RbacExtension {
  gather(_request: DecisionRequest, ctx: EvaluationContext, input: RbacInput, sources: RbacSources): Partial<RbacInput> | Promise<Partial<RbacInput>> {
    const resolver = sources.subjects;
    if (!isSetResolver(resolver)) return {};
    const base = input.subjects ?? [];
    const baseKeys = new Set(base.map(subjectKey));
    const memberships = resolver.memberships(input.assignments, input.roles, input.now);
    const direct = [...memberships].filter(([key]) => !baseKeys.has(key)).map(([, m]) => m.subject);
    const finish = (found: readonly { readonly setKey: string; readonly expiresAt?: Date }[]): Maybe<Partial<RbacInput>> => {
      const nested = new Map<string, NestedSet>();
      for (const { setKey, expiresAt } of found) {
        const set = parseSetKey(setKey);
        if (!set) throw new Error(`rbac: the membership store returned ${JSON.stringify(setKey)}, which is no set key`);
        const key = subjectKey(set);
        if (!baseKeys.has(key) && !memberships.has(key)) nested.set(key, Object.freeze({ subject: set, ...(expiresAt ? { expiresAt } : {}) }));
      }
      const extra: Partial<RbacInput> = { ...(memberships.size > 0 ? { memberships } : {}), ...(nested.size > 0 ? { nestedSets: nested } : {}) };
      const sets: AssignmentSubject[] = [...direct, ...[...nested.values()].map((n) => n.subject)];
      if (sets.length === 0) return extra;
      const merge = (rows: readonly Assignment[]): Partial<RbacInput> => ({ ...extra, subjects: [...base, ...sets], assignments: [...input.assignments, ...rows] });
      const rows = sources.load ? sources.load(sets, ctx) : sources.assignments.forSubjects(sets, input.now);
      return isThenable(rows) ? Promise.resolve(rows).then(merge) : merge(rows);
    };
    if (!sources.setsOf) {
      const out = finish([]);
      return isThenable(out) ? Promise.resolve(out) : out;
    }
    return sources.setsOf(memberKeysOf(base), ctx).then(finish);
  }
}

export const setsExtension: RbacExtensionFactory = () => new SetsExtension();

/**
 * Step 1, right after collect: an assignment made to a set the principal joined through its own rows holds
 * only while one of those memberships does (its role inside the ceiling, unless the assignment is a deny),
 * and the latest one bounds its expiry. One made to a nested set holds without a ceiling only (lane L8
 * decision 5), bounded by that membership's expiry; a deny holds either way.
 */
export const applyMemberships: RbacStep = (s) => {
  if (!s.input.memberships && !s.input.nestedSets) return;
  s.live = s.live.flatMap((l) => throughMembership(s, l, false));
  s.scoped = s.scoped.flatMap((l) => throughMembership(s, l, false));
  s.denied = s.denied.flatMap((l) => throughMembership(s, l, true));
};

function throughMembership(s: RbacState, l: LiveAssignment, deny: boolean): LiveAssignment[] {
  const subject = l.assignment.subject;
  if (!('set' in subject)) return [l];
  const key = subjectKey(subject);
  const entry = s.input.memberships?.get(key);
  if (entry) {
    const usable = usableVia(s, entry.via, deny);
    if (usable.length === 0) return [];
    if (usable.some((m) => m.expiresAt === undefined)) return [l];
    const end = Math.max(...usable.map((m) => m.expiresAt!.getTime()));
    return l.expiresAt && l.expiresAt.getTime() <= end ? [l] : [{ ...l, expiresAt: new Date(end) }];
  }
  const nested = s.input.nestedSets?.get(key);
  if (!nested) return [l];
  if (!deny && s.ceilingRoles !== undefined) return [];
  const end = nested.expiresAt?.getTime();
  if (end === undefined || (l.expiresAt && l.expiresAt.getTime() <= end)) return [l];
  return end > s.input.now.getTime() ? [{ ...l, expiresAt: new Date(end) }] : [];
}

/** The live memberships among `via`, those whose role passes the ceiling unless `ignoreCeiling` (a deny). */
export function usableVia<T extends { readonly role: string; readonly expiresAt?: Date }>(s: RbacState, via: readonly T[], ignoreCeiling = false): T[] {
  const now = s.input.now.getTime();
  return via.filter((m) => (ignoreCeiling || withinCeiling(s, m.role)) && (m.expiresAt === undefined || m.expiresAt.getTime() > now));
}

/** The subjects a list term may name: those of the input, without a set none of whose memberships holds now, nor a nested set under a ceiling. */
export function usableSubjects(s: RbacState): readonly AssignmentSubject[] | undefined {
  const { subjects, memberships, nestedSets } = s.input;
  if (!subjects || (!memberships && !nestedSets)) return subjects;
  return subjects.filter((subject) => {
    if (!('set' in subject)) return true;
    const key = subjectKey(subject);
    const entry = memberships?.get(key);
    if (entry) return usableVia(s, entry.via).length > 0;
    return !nestedSets?.has(key) || s.ceilingRoles === undefined;
  });
}

const isThenable = <T>(v: Maybe<T>): v is PromiseLike<T> => typeof (v as { then?: unknown } | null)?.then === 'function';
