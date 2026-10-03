import { AuthzConfigError, GLOBAL } from '@spinajs/authz';
import type { AssignmentSubject, PrincipalRef, ResourceRef } from '@spinajs/authz';

/** A subject as `authz_assignment` and `authz_rule_subject` store it (D-L2-7). */
export interface SubjectColumns {
  readonly subject_type: string;
  readonly subject_id: string;
  /** `''` for a principal; the set's role for a subject set. */
  readonly subject_role: string;
}

export interface ScopeColumns {
  readonly scope_type: string;
  readonly scope_id: string;
}

/** A principal is `(type, id, '')`; a subject set `{ set: { role, scope } }` is `(scope.type, scope.id, role)`. */
export function subjectToColumns(subject: AssignmentSubject): SubjectColumns {
  if ('set' in subject) {
    if (typeof subject.set.role !== 'string' || subject.set.role === '') {
      throw new AuthzConfigError(`Subject set at ${subject.set.scope.type}:${subject.set.scope.id ?? ''} has an empty role; it would match the principal`);
    }
    const { scope_type, scope_id } = scopeToColumns(subject.set.scope);
    return { subject_type: scope_type, subject_id: scope_id, subject_role: subject.set.role };
  }

  return { subject_type: subject.type, subject_id: subject.id, subject_role: '' };
}

export function subjectFromColumns(type: string, id: string, role: string | null | undefined): AssignmentSubject {
  if (!role) return { type, id };
  return { set: { role, scope: scopeFromColumns(type, id) } };
}

/** GLOBAL is `('$global', '')`; a type-level ref keeps `''` as its id. */
export function scopeToColumns(scope: ResourceRef): ScopeColumns {
  if (scope.type === GLOBAL.type) return { scope_type: GLOBAL.type, scope_id: '' };
  return { scope_type: scope.type, scope_id: scope.id ?? '' };
}

export function scopeFromColumns(type: string, id: string | null | undefined): ResourceRef {
  if (type === GLOBAL.type) return GLOBAL;
  return id ? { type, id } : { type };
}

/** Inverse of the core's `principalKey` (`type:id`, `%` and `:` escaped in the type); undefined when malformed. */
export function parsePrincipalKey(key: string | null | undefined): PrincipalRef | undefined {
  if (!key) return undefined;
  const at = key.indexOf(':');
  if (at <= 0) return undefined;
  return { type: key.slice(0, at).replace(/%3A/g, ':').replace(/%25/g, '%'), id: key.slice(at + 1) };
}

const SQL_LOCAL = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/;

/**
 * A datetime column as a `Date`. Postgres hands back a `Date`; SQLite hands back the text the ORM
 * wrote, the local wall clock without a zone, so it is read in the local zone like the ORM writes it.
 */
export function toDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;

  if (typeof value === 'string') {
    const m = SQL_LOCAL.exec(value);
    if (m) {
      const ms = m[7] ? Number(m[7].padEnd(3, '0').slice(0, 3)) : 0;
      return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0), ms);
    }

    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  throw new AuthzConfigError(`Unreadable datetime value ${JSON.stringify(value)}`);
}
