import { AuthzConfigError, GLOBAL } from '@spinajs/authz';
import type { ChangeRecord, Permission, ResourceRef } from '@spinajs/authz';
import { GLOBAL_TYPE, HistoryContributors, StoredPolicySplicers, parseStoredPolicyName, storedPolicyName } from '@spinajs/authz-ir';
import type { CurrentItem, HistoryEdge, KeyState, ObjectRef, OpaqueRef, PolicyIR, RelationDef, RelationName, Rewrite, StoredEdge, StoredPlaceholder, TupleSubjectRef, TypeName } from '@spinajs/authz-ir';
import { Injectable, Singleton } from '@spinajs/di';

import type { AssignmentSubject, RuleDef } from './contracts.js';
import { rbacDenyRelation } from './ir.js';
import { ruleCanMatch } from './model/list/support.js';
import { rowToAssignment } from './stores/assignment-row.js';
import { scopeToColumns, subjectToColumns } from './stores/columns.js';
import { DB_RULE_STORE_NAME, rowToRule } from './stores/db-rule-store.js';
import { AssignmentRecord, RuleRecord, RuleSubjectRecord } from './stores/records.js';
import type { RuleSubjectFields } from './stores/records.js';
import { AUTHZ_ASSIGNMENT_TABLE } from './stores/tables.js';

type Source = RelationDef['source'];

/** What replay reads of an assignment image, from a current row (`expiresAt` a Date) or a logged payload (a string). */
interface Grant {
  scope: ObjectRef;
  role: string;
  subject: TupleSubjectRef;
  expiresAt: number | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const objectOf = (scope: Record<string, unknown>): ObjectRef | undefined =>
  typeof scope.type !== 'string' ? undefined : { type: scope.type, id: scope.type === GLOBAL.type ? GLOBAL_TYPE : typeof scope.id === 'string' ? scope.id : '' };

const scopeOf = (object: ObjectRef): ResourceRef => (object.type === GLOBAL_TYPE ? GLOBAL : { type: object.type, id: object.id });

function subjectOf(s: unknown): TupleSubjectRef | undefined {
  if (!isRecord(s)) return undefined;
  if (isRecord(s.set)) {
    const scope = isRecord(s.set.scope) ? objectOf(s.set.scope) : undefined;
    return scope === undefined || typeof s.set.role !== 'string' ? undefined : { ...scope, relation: s.set.role };
  }
  return typeof s.type === 'string' && typeof s.id === 'string' ? { type: s.type, id: s.id } : undefined;
}

const assignmentSubject = (s: TupleSubjectRef): AssignmentSubject => (s.relation === undefined ? { type: s.type, id: s.id } : { set: { role: s.relation, scope: scopeOf(s) } });

function instant(v: unknown): number | null | undefined {
  if (v === null) return null;
  const ms = v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) : Number.NaN;
  return Number.isNaN(ms) ? undefined : ms;
}

function grantOf(image: unknown): Grant | undefined {
  if (!isRecord(image) || typeof image.role !== 'string' || !isRecord(image.scope)) return undefined;
  const scope = objectOf(image.scope);
  const subject = subjectOf(image.subject);
  const expiresAt = instant(image.expiresAt ?? null);
  return scope === undefined || subject === undefined || expiresAt === undefined ? undefined : { scope, role: image.role, subject, expiresAt };
}

/**
 * Rebuilds the RBAC role relations (`authz_assignment`, kind `assignment`, keyed by assignment id) at a decision's
 * instant. Current rows are read on the primary with expired ones included: an assignment that expired between T and
 * now is absent from a live read and has no change after T. Liveness at T is `subjectAt`'s.
 */
@Singleton()
@Injectable(HistoryContributors)
export class AssignmentHistoryContributor extends HistoryContributors {
  readonly kind = 'assignment' as const;

  /** `expires_at` is a `dateTime` column: DATETIME(3), TIMESTAMPTZ(3) or ISO text, milliseconds on every dialect. */
  readonly precisionMs = 1;

  serves(source: Source): boolean {
    return source.kind === 'tuples' && source.store === AUTHZ_ASSIGNMENT_TABLE;
  }

  coverageType(): undefined {
    return undefined;
  }

  async current(object: ObjectRef, relation: RelationName): Promise<CurrentItem<TupleSubjectRef>[]> {
    const rows = await AssignmentRecord.query().onPrimary().where('role', relation).where(scopeToColumns(scopeOf(object)));
    return rows.flatMap((row) => this.item(row, (g) => g.subject));
  }

  async currentReverse(subject: TupleSubjectRef, relation: RelationName, objectType: TypeName): Promise<CurrentItem<ObjectRef>[]> {
    const rows = await AssignmentRecord.query().onPrimary().where('role', relation).where('scope_type', objectType).where(subjectToColumns(assignmentSubject(subject)));
    return rows.flatMap((row) => this.item(row, (g) => g.scope));
  }

  /** A put keeps the subject, role and scope (an assignment's id is its grant), so every op touches one edge. */
  edges(change: ChangeRecord): HistoryEdge[] {
    const g = grantOf(change.payload) ?? grantOf(change.before);
    return g === undefined ? [] : [{ key: change.key, object: g.scope, relation: g.role, subject: g.subject }];
  }

  /** Live at `at` as the store's `whereLive` reads it: no expiry, or one strictly after `at`. */
  subjectAt(image: unknown, at: Date): TupleSubjectRef | undefined {
    const g = grantOf(image);
    return g === undefined || (g.expiresAt !== null && g.expiresAt <= at.getTime()) ? undefined : g.subject;
  }

  private item<S>(row: AssignmentRecord, carrier: (g: Grant) => S): CurrentItem<S>[] {
    const image = rowToAssignment(row);
    const g = grantOf(image);
    return g === undefined ? [] : [{ key: row.id, image, subject: carrier(g) }];
  }
}

const isRuleKind = (v: unknown): v is RuleDef['kind'] => v === 'restrict' || v === 'cap' || v === 'threshold';
const isStrings = (v: unknown): v is readonly string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** The fields `ruleCanMatch` reads, or undefined when the image is not a rule. */
function matchable(image: unknown): Pick<RuleDef, 'kind' | 'resourceTypes' | 'permissions'> | undefined {
  if (!isRecord(image) || !isRuleKind(image.kind)) return undefined;
  const { resourceTypes, permissions } = image;
  if ((resourceTypes !== undefined && !isStrings(resourceTypes)) || (permissions !== undefined && !isStrings(permissions))) return undefined;
  return { kind: image.kind, ...(resourceTypes === undefined ? {} : { resourceTypes }), ...(permissions === undefined ? {} : { permissions }) };
}

/** A rule whose permission globs do not parse can match anything. */
function canMatch(rule: Pick<RuleDef, 'kind' | 'resourceTypes' | 'permissions'>, permission: Permission, type: TypeName): boolean {
  try {
    return ruleCanMatch(rule, permission, type);
  } catch (e) {
    if (e instanceof AuthzConfigError) return true;
    throw e;
  }
}

/**
 * Splices the rules of `DbRuleStore` (kind `rule`, keyed by rule id) as they were at a decision's instant into the deny
 * relation of each permission. The IR cannot express a rule, so each one that can match the permission stays opaque,
 * named after it, and the others drop out: with no applicable rule at T the replay is exact. Other rule stores log no
 * changes, so their placeholders stay.
 */
@Singleton()
@Injectable(StoredPolicySplicers)
export class RuleSplicer extends StoredPolicySplicers {
  readonly kind = 'rule' as const;

  locate(opaqueName: string, type: TypeName, relation: RelationName, ir: PolicyIR): StoredPlaceholder | undefined {
    const stored = parseStoredPolicyName(opaqueName);
    const permissions = Object.entries(ir.permissions).filter(([p, b]) => b.type === type && rbacDenyRelation(p) === relation);
    // Two permissions whose names differ only in the characters a relation name cannot hold share the relation.
    return stored === undefined || permissions.length !== 1 ? undefined : { ...stored, permission: permissions[0][0], side: 'deny' };
  }

  /** Every rule, expired ones included: the splicer does not know the `now` an expiry was judged at, so it never drops one. */
  async current(store: string): Promise<Array<{ key: string; image: unknown }>> {
    if (store !== DB_RULE_STORE_NAME) return [];
    const rows = await RuleRecord.query().onPrimary();
    const subjects = new Map<string, RuleSubjectFields[]>();
    for (const s of rows.length === 0 ? [] : await RuleSubjectRecord.query().onPrimary()) subjects.set(s.rule_id, [...(subjects.get(s.rule_id) ?? []), s]);
    return rows.map((r) => ({ key: r.id, image: rowToRule(r, subjects.get(r.id) ?? []) }));
  }

  edge(change: ChangeRecord): StoredEdge {
    return { store: DB_RULE_STORE_NAME, key: change.key };
  }

  splice(at: StoredPlaceholder, items: ReadonlyArray<{ key: string; state: KeyState }>, ir: PolicyIR): { term: Rewrite; opaque?: OpaqueRef[] } {
    if (at.store !== DB_RULE_STORE_NAME) return { term: { opaque: storedPolicyName(at.model, at.store) } };
    const type = Object.entries(ir.permissions).find(([p]) => p === at.permission)?.[1].type;
    const names = items.flatMap(({ key, state }) => {
      if (state.known && state.value === undefined) return [];
      const rule = state.known ? matchable(state.value) : undefined;
      return rule !== undefined && type !== undefined && !canMatch(rule, at.permission, type) ? [] : [`rbac rule ${key}`];
    });
    const terms: Rewrite[] = names.map((name) => ({ opaque: name }));
    return { term: terms.length === 0 ? { priority: [] } : terms.length === 1 ? terms[0] : { union: terms }, opaque: names.map((name): OpaqueRef => ({ kind: 'rewrite', name })) };
  }
}
