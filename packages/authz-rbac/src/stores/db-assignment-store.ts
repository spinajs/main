import { AuthzAdminFailure, principalKey } from '@spinajs/authz';
import type { AuthzTx, PrincipalRef, ResourceRef } from '@spinajs/authz';
import type { Assignment, AssignmentSubject } from '../contracts.js';
import { Autoinject, Container, Inject, Injectable, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Orm, UniqueViolation } from '@spinajs/orm';
import type { IWhereBuilder } from '@spinajs/orm';
import type { DateTime } from 'luxon';
import { randomUUID } from 'node:crypto';

import { AdminAssignmentStore } from '../admin/ports.js';
import type { AssignmentQuery, ListResult, Page } from '../admin/ports.js';
import { rowToAssignment } from './assignment-row.js';
import { ASSIGNMENT_COLUMN_WIDTHS, SUBJECT_KEY_MAX_LENGTH, scopeToColumns, subjectKeyOf, subjectToColumns } from './columns.js';
import { requireTransaction } from './context.js';
import { withDbRbacStore } from './db-store.js';
import { applyWindow, pageWindow, requireScopeNode, trimWindow, whereLive } from './queries.js';
import type { ListWindow } from './queries.js';
import { AssignmentRecord, recordValues, toDateTime } from './records.js';
import type { AssignmentFields } from './records.js';
import { normaliseTags, parseTags } from './tags.js';
import { bumpVersion } from './version.js';

/** Rows of one scope, optionally narrowed to a subject and a role (`assignment.revokeWhere`). */
export interface AssignmentFilter {
  readonly scope: ResourceRef;
  readonly subject?: AssignmentSubject;
  readonly role?: string;
}

/** `AuthzAdmin.list({ kind: 'assignments' })` without the kind. */
export interface AssignmentListQuery {
  readonly scope?: ResourceRef;
  readonly subject?: AssignmentSubject;
  readonly role?: string;
  readonly includeExpired?: boolean;
  readonly page?: { readonly limit: number; readonly offset: number; readonly after?: string };
}

/** The columns `authz_assignment_uq` keys a grant by. */
export type AssignmentKey = Pick<AssignmentFields, 'subject_type' | 'subject_id' | 'subject_role' | 'role' | 'scope_type' | 'scope_id'>;

/** The most rows one `list` call returns, with or without a page. */
export const ASSIGNMENT_LIST_MAX_LIMIT = 1000;

const TAG_RETRIES = 5;

/**
 * `AssignmentStore` over `authz_assignment`, on the `authz` connection. Writes run on the `AuthzTx`
 * of `AuthzAdmin` and bump `authz_version` of the store's domain in that transaction. Registered by
 * class name only; a domain uses it by registering it as `AdminAssignmentStore` and `AssignmentStore`.
 */
@PerChildInstance()
@Injectable()
@Inject(Container)
export class DbAssignmentStore extends withDbRbacStore(AdminAssignmentStore) {
  /** Never read: injecting it resolves the Orm, which binds the models, before the first query. */
  @Autoinject(Orm)
  protected Orm: Orm;

  readonly name: string = 'DbAssignmentStore';

  protected readonly maxListLimit: number = ASSIGNMENT_LIST_MAX_LIMIT;

  constructor(protected readonly container: IContainer) {
    super();
  }

  async forSubjects(subjects: readonly AssignmentSubject[], at: Date): Promise<readonly Assignment[]> {
    return (await this.rowsForKeys(subjects.map(subjectKeyOf), at)).map(rowToAssignment);
  }

  async forSubjectKeys(keys: readonly string[], at: Date): Promise<readonly Assignment[]> {
    return (await this.rowsForKeys(keys, at)).map(rowToAssignment);
  }

  async holders(role: string, scope: ResourceRef, at: Date): Promise<readonly AssignmentSubject[]> {
    const query = AssignmentRecord.query().where('role', role).where(scopeToColumns(scope));
    whereLive(query, at);

    return (await query).map((r) => rowToAssignment(r).subject);
  }

  async byId(id: string): Promise<Assignment | null> {
    const row = await rowById(id);
    return row ? rowToAssignment(row) : null;
  }

  /** Grants, or updates tags, expiry and grantor of the existing (subject, role, scope) row, keeping its id. */
  async assign(a: Omit<Assignment, 'id' | 'source'>, actor: PrincipalRef, tx: AuthzTx): Promise<Assignment> {
    const where = `${this.name}.assign`;
    requireTransaction(AssignmentRecord, tx, where);
    const key: AssignmentKey = { ...subjectToColumns(a.subject), role: a.role, ...scopeToColumns(a.scope) };
    const subjectKey = subjectKeyOf(a.subject);
    if (subjectKey.length > SUBJECT_KEY_MAX_LENGTH) {
      throw new AuthzAdminFailure('invalid_command', `${where}: the subject key ${JSON.stringify(subjectKey.slice(0, 40))}… is longer than ${SUBJECT_KEY_MAX_LENGTH} characters`, 'subject');
    }
    for (const column of ['role', 'scope_type', 'scope_id'] as const) {
      if (key[column].length > ASSIGNMENT_COLUMN_WIDTHS[column]) {
        throw new AuthzAdminFailure('invalid_command', `${where}: ${column} is longer than ${ASSIGNMENT_COLUMN_WIDTHS[column]} characters`, column === 'role' ? 'role' : 'scope');
      }
    }
    const change = { tags: normaliseTags(a.tags), expires_at: toDateTime(a.expiresAt), granted_by: principalKey(actor) };

    const existing = await this.existingRow(key);
    let row: AssignmentFields;

    if (existing) {
      await AssignmentRecord.update(recordValues<AssignmentRecord>(change)).where('id', existing.id);
      row = { ...existing, ...change };
    } else {
      row = { id: randomUUID(), ...key, subject_key: subjectKey, ...change, source: 'db', created_at: toDateTime(this.now()) };
      try {
        await AssignmentRecord.insert(recordValues<AssignmentRecord>(row));
      } catch (err) {
        if (!(err instanceof UniqueViolation)) throw err;
        throw new AuthzAdminFailure('conflict', `${where}: another transaction granted ${a.role} to the same subject at the same scope; retry`, undefined, { cause: err });
      }
    }

    await bumpVersion(tx, this.domain(), where);
    return rowToAssignment(row);
  }

  /** Unknown id ⇒ `AuthzAdminFailure('not_found')`. */
  async revoke(id: string, _actor: PrincipalRef, tx: AuthzTx): Promise<void> {
    const where = `${this.name}.revoke`;
    requireTransaction(AssignmentRecord, tx, where);
    await requireRow(id);
    await AssignmentRecord.destroy().where('id', id);
    await bumpVersion(tx, this.domain(), where);
  }

  /** Replaces the tags (`assignment.setTags`); returns the updated assignment. */
  async setTags(id: string, tags: readonly string[], tx: AuthzTx): Promise<Assignment> {
    const where = `${this.name}.setTags`;
    requireTransaction(AssignmentRecord, tx, where);
    const text = normaliseTags(tags);
    const row = await requireRow(id);
    await AssignmentRecord.update({ tags: text }).where('id', id);
    await bumpVersion(tx, this.domain(), where);
    return rowToAssignment({ ...row, tags: text });
  }

  /** Adds tags (`assignment.addTags`); returns the updated assignment. */
  async addTags(id: string, tags: readonly string[], tx: AuthzTx): Promise<Assignment> {
    normaliseTags(tags);
    return this.changeTags(id, tx, `${this.name}.addTags`, (current) => [...current, ...tags]);
  }

  /** Removes tags (`assignment.removeTags`); returns the updated assignment. */
  async removeTags(id: string, tags: readonly string[], tx: AuthzTx): Promise<Assignment> {
    normaliseTags(tags);
    const gone = new Set(tags);
    return this.changeTags(id, tx, `${this.name}.removeTags`, (current) => current.filter((t) => !gone.has(t)));
  }

  /** `AdminAssignmentStore.update`: the tags and/or expiry given, in one write and one bump. */
  async update(id: string, patch: { readonly tags?: readonly string[]; readonly expiresAt?: Date | null }, _actor: PrincipalRef, tx: AuthzTx): Promise<Assignment> {
    const where = `${this.name}.update`;
    requireTransaction(AssignmentRecord, tx, where);
    const change: { tags?: string; expires_at?: DateTime | null } = {};
    if (patch.tags !== undefined) change.tags = normaliseTags(patch.tags);
    if (patch.expiresAt !== undefined) change.expires_at = toDateTime(patch.expiresAt);

    const row = await requireRow(id);
    if (Object.keys(change).length > 0) await AssignmentRecord.update(recordValues<AssignmentRecord>(change)).where('id', id);
    await bumpVersion(tx, this.domain(), where);
    return rowToAssignment({ ...row, ...change });
  }

  /** Sets or clears (`null`) the expiry (`assignment.setExpiry`); returns the updated assignment. */
  async setExpiry(id: string, expiresAt: Date | null, tx: AuthzTx): Promise<Assignment> {
    const where = `${this.name}.setExpiry`;
    requireTransaction(AssignmentRecord, tx, where);
    const row = await requireRow(id);
    const expires_at = toDateTime(expiresAt);
    await AssignmentRecord.update(recordValues<AssignmentRecord>({ expires_at })).where('id', id);
    await bumpVersion(tx, this.domain(), where);
    return rowToAssignment({ ...row, expires_at });
  }

  /** Deletes the rows at `scope` matching `subject` and `role`, expired ones too (`assignment.revokeWhere`); returns them. */
  async revokeWhere(filter: AssignmentFilter, tx: AuthzTx): Promise<readonly Assignment[]> {
    const where = `${this.name}.revokeWhere`;
    requireTransaction(AssignmentRecord, tx, where);
    return this.deleteWhere(tx, where, (query) => whereFilter(query, filter));
  }

  /** Deletes every row of `subjects` at any scope, expired ones too (a revoked share link); returns them. */
  async revokeSubjects(subjects: readonly AssignmentSubject[], tx: AuthzTx): Promise<readonly Assignment[]> {
    const where = `${this.name}.revokeSubjects`;
    requireTransaction(AssignmentRecord, tx, where);
    return this.deleteRows(tx, where, await this.rowsForKeys(subjects.map(subjectKeyOf), undefined));
  }

  /**
   * `scope.forget`: deletes every row AT `scope` (not below it) and every grant whose subject is a
   * set living at `scope`, wherever it is held, so a later scope with the same id inherits nothing.
   * Returns them. GLOBAL and type-level refs are refused (`wrong_scope_type`).
   */
  async forgetScope(scope: ResourceRef, tx: AuthzTx): Promise<readonly Assignment[]> {
    const where = `${this.name}.forgetScope`;
    requireScopeNode(scope, where, 'only a scope node can be forgotten');
    requireTransaction(AssignmentRecord, tx, where);

    const columns = scopeToColumns(scope);
    return this.deleteWhere(tx, where, (query) =>
      query.where(function () {
        this.where(columns);
        this.orWhere(function () {
          this.where('subject_type', columns.scope_type).where('subject_id', columns.scope_id).where('subject_role', '!=', '');
        });
      }),
    );
  }

  /**
   * Filtered page for `AuthzAdmin.list` (kind `assignments`), oldest first; `total` counts the unpaged
   * result. At most {@link ASSIGNMENT_LIST_MAX_LIMIT} rows, with or without a page; a negative or
   * fractional `limit` or `offset` is `invalid_page`.
   * `page.after` (the `next` of an earlier page) continues behind that row instead of skipping `offset`
   * rows; a cursor this list did not issue, or one with an `offset`, is `invalid_page`. `next` is set
   * when more rows follow and the page has no `offset`.
   */
  async list(q: AssignmentListQuery, at: Date): Promise<ListResult<Assignment>> {
    return this.select(q, at, pageWindow(q.page, this.maxListLimit, `${this.name}.list`));
  }

  /**
   * `AdminAssignmentStore.find` with `q.at` as now. With a page, as {@link list}; without one, every
   * match in one query: AuthzAdmin's guard reads that as the full set (escalation, self-lockout).
   */
  async find(q: AssignmentQuery, page?: Page): Promise<ListResult<Assignment>> {
    const { at, ...filter } = q;
    return this.select(filter, at, page ? pageWindow(page, this.maxListLimit, `${this.name}.find`) : undefined);
  }

  /** Rows of these subject keys; `at` undefined keeps expired rows. */
  private async rowsForKeys(keys: readonly string[], at: Date | undefined): Promise<AssignmentRecord[]> {
    const unique = [...new Set(keys)];
    if (unique.length === 0) return [];
    const query = AssignmentRecord.query().whereIn('subject_key', unique);
    if (at) whereLive(query, at);
    return query;
  }

  /** The filtered rows, oldest first; `window` undefined reads every match in one query. */
  private async select(q: Omit<AssignmentListQuery, 'page'>, at: Date, window: ListWindow | undefined): Promise<ListResult<Assignment>> {
    const filtered = () => {
      const query = AssignmentRecord.query();
      whereFilter(query, q);
      if (!q.includeExpired) whereLive(query, at);
      return query;
    };

    if (!window) {
      const items = (await filtered().orderBy('created_at').orderBy('id')).map(rowToAssignment);
      return { items, total: items.length };
    }

    const total = await filtered().selectCount();
    if (window.limit === 0) return { items: [], total };

    const { rows, next } = trimWindow(await applyWindow(filtered().orderBy('created_at').orderBy('id'), window), window);

    return { items: rows.map(rowToAssignment), total, ...(next === undefined ? {} : { next }) };
  }

  protected async existingRow(key: AssignmentKey): Promise<AssignmentRecord | undefined> {
    const [row] = await AssignmentRecord.query().where(key);
    return row;
  }

  /** Read-modify-write guarded by the old tags, so a concurrent change is retried instead of lost. */
  private async changeTags(id: string, tx: AuthzTx, where: string, change: (current: string[]) => string[]): Promise<Assignment> {
    requireTransaction(AssignmentRecord, tx, where);

    for (let attempt = 1; ; attempt++) {
      const row = await requireRow(id);
      const tags = normaliseTags(change(parseTags(row.tags)));
      const { RowsAffected } = await AssignmentRecord.update({ tags }).where('id', id).where('tags', row.tags);

      if (RowsAffected > 0) {
        await bumpVersion(tx, this.domain(), where);
        return rowToAssignment({ ...row, tags });
      }

      if (attempt >= TAG_RETRIES) {
        throw new AuthzAdminFailure('conflict', `${where}: the tags of assignment ${id} kept changing concurrently`);
      }
    }
  }

  private async deleteWhere(tx: AuthzTx, where: string, filter: (query: IWhereBuilder<unknown>) => void): Promise<readonly Assignment[]> {
    const query = AssignmentRecord.query();
    filter(query);
    return this.deleteRows(tx, where, await query);
  }

  private async deleteRows(tx: AuthzTx, where: string, rows: readonly AssignmentRecord[]): Promise<readonly Assignment[]> {
    if (rows.length > 0) {
      await AssignmentRecord.destroy().whereIn(
        'id',
        rows.map((r) => r.id),
      );
    }

    await bumpVersion(tx, this.domain(), where);
    return rows.map(rowToAssignment);
  }
}

function whereFilter(query: IWhereBuilder<unknown>, filter: { scope?: ResourceRef; subject?: AssignmentSubject; role?: string }): void {
  if (filter.scope) query.where(scopeToColumns(filter.scope));
  if (filter.subject) query.where(subjectToColumns(filter.subject));
  if (filter.role !== undefined) query.where('role', filter.role);
}

async function rowById(id: string): Promise<AssignmentRecord | undefined> {
  const [row] = await AssignmentRecord.query().where('id', id);
  return row;
}

async function requireRow(id: string): Promise<AssignmentRecord> {
  const row = await rowById(id);
  if (!row) throw new AuthzAdminFailure('not_found', `Assignment ${JSON.stringify(id)} does not exist`, 'id');
  return row;
}
