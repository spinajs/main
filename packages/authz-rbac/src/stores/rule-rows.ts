import { AuthzAdminFailure } from '@spinajs/authz';
import type { AssignmentSubject, PrincipalRef, RuleDef } from '@spinajs/authz';

import { scopeToColumns, subjectToColumns } from './columns.js';
import type { SubjectColumns } from './columns.js';

export const AUTHZ_RULE_TABLE = 'authz_rule';
export const AUTHZ_RULE_SUBJECT_TABLE = 'authz_rule_subject';

export type RuleSubjectList = 'allow' | 'refs';

/** The `authz_rule` values of one rule, except `created_*`. */
export interface RuleColumns {
  readonly id: string;
  readonly kind: RuleDef['kind'];
  readonly scope_type: string;
  readonly scope_id: string;
  /** The rule as JSON without `id`, `scope` and `expiresAt` (their columns hold them). */
  readonly definition: string;
  readonly expires_at: Date | null;
}

export interface RuleSubjectRow extends SubjectColumns {
  readonly rule_id: string;
  readonly list: RuleSubjectList;
}

/** An `authz_rule` row as a driver returns it (datetimes as text on SQLite). */
export type RuleRow = { readonly [K in keyof RuleColumns]: unknown } & { readonly created_by?: unknown; readonly created_at?: unknown };

export interface RuleRows {
  readonly rule: RuleColumns;
  /** `allow` and `subjects.refs`, deduplicated, sorted by (list, type, id, role). */
  readonly subjects: readonly RuleSubjectRow[];
}

/** varchar lengths of design §9.1 (Postgres enforces them; SQLite does not). */
const LEN = { id: 160, scopeType: 64, scopeId: 64, subjectType: 32, subjectId: 64, subjectRole: 128 } as const;

/**
 * The `authz_rule` row and the `authz_rule_subject` rows of a rule. The subject rows exist so that
 * `scope.forget` can drop the list entries naming a forgotten subject set without parsing `definition`.
 * Only what the columns cannot hold is refused (`invalid_command`); the admin handler validated the rest.
 */
export function toRuleRows(rule: Omit<RuleDef, 'source'>): RuleRows {
  const refuse = (field: string, why: string): never => {
    throw new AuthzAdminFailure('invalid_command', `rule ${JSON.stringify(rule.id)}: ${why}`, `rule.${field}`);
  };

  if (typeof rule.id !== 'string' || rule.id === '' || rule.id.length > LEN.id) refuse('id', `the id must be a string of 1 to ${LEN.id} characters`);
  const scope = scopeToColumns(rule.scope);
  if (scope.scope_type.length > LEN.scopeType || scope.scope_id.length > LEN.scopeId) refuse('scope', `the scope type and id hold at most ${LEN.scopeType} characters each`);

  const { id: _id, scope: _scope, expiresAt: _expiresAt, source: _source, ...definition } = rule as Omit<RuleDef, 'source'> & { source?: unknown };

  const rows = new Map<string, RuleSubjectRow>();
  const add = (list: RuleSubjectList, field: string, s: AssignmentSubject) => {
    const c = subjectToColumns(s);
    if (c.subject_type.length > LEN.subjectType || c.subject_id.length > LEN.subjectId || c.subject_role.length > LEN.subjectRole) {
      refuse(field, `${field} holds ${JSON.stringify([c.subject_type, c.subject_id, c.subject_role])}, longer than authz_rule_subject holds (${LEN.subjectType}, ${LEN.subjectId}, ${LEN.subjectRole})`);
    }
    rows.set(JSON.stringify([list, c.subject_type, c.subject_id, c.subject_role]), { rule_id: rule.id, list, ...c });
  };
  for (const s of rule.allow ?? []) add('allow', 'allow', s);
  for (const p of (rule.subjects?.refs ?? []) as readonly PrincipalRef[]) add('refs', 'subjects.refs', { type: p.type, id: p.id });

  return {
    rule: { id: rule.id, kind: rule.kind, ...scope, definition: JSON.stringify(definition), expires_at: rule.expiresAt ?? null },
    subjects: [...rows.values()].sort(compareRows),
  };
}

function compareRows(a: RuleSubjectRow, b: RuleSubjectRow): number {
  for (const k of ['list', 'subject_type', 'subject_id', 'subject_role'] as const) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  return 0;
}
