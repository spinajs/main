import type { Assignment, AssignmentSubject, DecisionRequest, EvaluationContext } from '@spinajs/authz';

import { subjectKey } from '../assignments.js';
import { withinCeiling } from '../ceiling.js';
import type { LiveAssignment, RbacExtension, RbacExtensionFactory, RbacInput, RbacSources, RbacState, RbacStep } from '../evaluate.js';
import { isSetResolver } from './resolver.js';
import type { SetMemberships } from './resolver.js';

type Maybe<T> = T | PromiseLike<T>;

/**
 * Subject sets (design §6.1.3): after the principal's own assignments are read, the sets they make it
 * a member of are read too, in one more store read (cached per subject like the first), and join
 * `subjects` and `assignments`. Only a resolver with `memberships` (RbacSubjectResolver, the default)
 * names them; another SubjectResolver decides the subjects alone.
 */
export class SetsExtension implements RbacExtension {
  gather(_request: DecisionRequest, ctx: EvaluationContext, input: RbacInput, sources: RbacSources): Partial<RbacInput> | Promise<Partial<RbacInput>> {
    const resolver = sources.subjects;
    if (!isSetResolver(resolver)) return {};
    const base = new Set((input.subjects ?? []).map(subjectKey));
    const memberships = resolver.memberships(input.assignments, input.roles, input.now);
    const sets: AssignmentSubject[] = [...memberships].filter(([key]) => !base.has(key)).map(([, m]) => m.subject);
    if (sets.length === 0) return memberships.size > 0 ? { memberships } : {};
    const merge = (rows: readonly Assignment[]): Partial<RbacInput> => ({ subjects: [...(input.subjects ?? []), ...sets], assignments: [...input.assignments, ...rows], memberships });
    const rows = sources.load ? sources.load(sets, ctx) : sources.assignments.forSubjects(sets, input.now);
    return isThenable(rows) ? Promise.resolve(rows).then(merge) : merge(rows);
  }
}

export const setsExtension: RbacExtensionFactory = () => new SetsExtension();

/**
 * Step 1, right after collect: an assignment made to a set the principal joined through its own
 * assignments holds only while one of those memberships does: its role passes `ceiling.roles` (a
 * ceiling never lets a set in through a role it leaves out) and it has not expired. The latest such
 * membership bounds the assignment's expiry, so it bounds validUntil wherever the assignment counts.
 */
export const applyMemberships: RbacStep = (s) => {
  const memberships = s.input.memberships;
  if (!memberships) return;
  s.live = s.live.flatMap((l) => throughMembership(s, memberships, l, false));
  s.scoped = s.scoped.flatMap((l) => throughMembership(s, memberships, l, false));
  s.denied = s.denied.flatMap((l) => throughMembership(s, memberships, l, true));
};

function throughMembership(s: RbacState, memberships: SetMemberships, l: LiveAssignment, deny: boolean): LiveAssignment[] {
  const subject = l.assignment.subject;
  const entry = 'set' in subject ? memberships.get(subjectKey(subject)) : undefined;
  if (!entry) return [l];
  const usable = usableVia(s, entry.via, deny);
  if (usable.length === 0) return [];
  if (usable.some((m) => m.expiresAt === undefined)) return [l];
  const end = Math.max(...usable.map((m) => m.expiresAt!.getTime()));
  return l.expiresAt && l.expiresAt.getTime() <= end ? [l] : [{ ...l, expiresAt: new Date(end) }];
}

/** The live memberships among `via`, those whose role passes the ceiling unless `ignoreCeiling` (a deny). */
export function usableVia<T extends { readonly role: string; readonly expiresAt?: Date }>(s: RbacState, via: readonly T[], ignoreCeiling = false): T[] {
  const now = s.input.now.getTime();
  return via.filter((m) => (ignoreCeiling || withinCeiling(s, m.role)) && (m.expiresAt === undefined || m.expiresAt.getTime() > now));
}

/** The subjects a native list term may name: those of the input, without a joined set none of whose memberships holds now. */
export function usableSubjects(s: RbacState): readonly AssignmentSubject[] | undefined {
  const { subjects, memberships } = s.input;
  if (!subjects || !memberships) return subjects;
  return subjects.filter((subject) => {
    const entry = 'set' in subject ? memberships.get(subjectKey(subject)) : undefined;
    return !entry || usableVia(s, entry.via).length > 0;
  });
}

const isThenable = <T>(v: Maybe<T>): v is PromiseLike<T> => typeof (v as { then?: unknown } | null)?.then === 'function';
