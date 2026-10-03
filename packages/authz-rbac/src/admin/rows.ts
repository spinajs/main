import { resourceKey } from '@spinajs/authz';
import type { PrincipalRef, ResourceRef } from '@spinajs/authz';

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

/** Structural identity of a subject; NUL separates parts no type, id or role contains. */
export function subjectKey(s: AssignmentSubject): string {
  return isSetSubject(s) ? `s\u0000${s.set.role}\u0000${resourceKey(s.set.scope)}` : `p\u0000${s.type}\u0000${s.id}`;
}

export const sameRef = (a: ResourceRef, b: ResourceRef): boolean => resourceKey(a) === resourceKey(b);

/** Sorted and deduplicated, as authz_assignment stores them (design §9.1). */
export function normaliseTags(tags: readonly string[] | undefined): string[] {
  return [...new Set(tags ?? [])].sort();
}

export const copyDate = (d: Date | null | undefined): Date | null => (d == null ? null : new Date(d.getTime()));

export const isLive = (expiresAt: Date | null | undefined, at: Date): boolean => expiresAt == null || expiresAt.getTime() > at.getTime();

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !(value instanceof Date) && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

export function paged<T>(items: readonly T[], page?: { readonly limit: number; readonly offset: number }): { items: readonly T[]; total: number } {
  if (!page) return { items, total: items.length };
  return { items: items.slice(page.offset, page.offset + page.limit), total: items.length };
}
