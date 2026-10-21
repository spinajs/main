import { resourceKey } from '@spinajs/authz';
import type { PrincipalRef, ResourceRef } from '@spinajs/authz';
import { deepFreeze as freeze, sortedUnique } from '@spinajs/util';

import type { AssignmentSubject } from '../contracts.js';

/** A plain copy: a ref without an id has no `id` key, so equal refs compare equal. */
export function copyRef(r: ResourceRef): ResourceRef {
  return r.id == null ? { type: r.type } : { type: r.type, id: r.id };
}

export function copyPrincipalRef(p: PrincipalRef): PrincipalRef {
  return { type: p.type, id: p.id };
}

export function isSetSubject(s: AssignmentSubject): s is Extract<AssignmentSubject, { set: unknown }> {
  return (s as { set?: unknown }).set !== undefined;
}

export function copySubject(s: AssignmentSubject): AssignmentSubject {
  return isSetSubject(s) ? { set: { role: s.set.role, scope: copyRef(s.set.scope) } } : copyPrincipalRef(s);
}


export const sameRef = (a: ResourceRef, b: ResourceRef): boolean => resourceKey(a) === resourceKey(b);

/** Sorted and deduplicated, as authz_assignment stores them. */
export function sortedTags(tags: readonly string[] | undefined): string[] {
  return sortedUnique(tags ?? []);
}

export const copyDate = (d: Date | null | undefined): Date | null => (d == null ? null : new Date(d.getTime()));

export const isLiveAt = (expiresAt: Date | null | undefined, at: Date): boolean => expiresAt == null || expiresAt.getTime() > at.getTime();

export const deepFreeze = <T>(value: T): Readonly<T> => freeze(value, { skipDates: true });
