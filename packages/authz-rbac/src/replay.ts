import { GLOBAL } from '@spinajs/authz';
import type { ChangeRecord, ResourceRef } from '@spinajs/authz';
import { GLOBAL_TYPE, HistoryContributors } from '@spinajs/authz-ir';
import type { CurrentItem, HistoryEdge, ObjectRef, RelationDef, RelationName, TupleSubjectRef, TypeName } from '@spinajs/authz-ir';
import { Injectable, Singleton } from '@spinajs/di';

import type { AssignmentSubject } from './contracts.js';
import { rowToAssignment } from './stores/assignment-row.js';
import { scopeToColumns, subjectToColumns } from './stores/columns.js';
import { AssignmentRecord } from './stores/records.js';
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
