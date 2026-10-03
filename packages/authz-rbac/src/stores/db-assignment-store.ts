import { AuthzAdminFailure, AuthzClock, GLOBAL, principalKey } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, AuthzTx, PrincipalRef, ResourceRef } from '@spinajs/authz';
import { Container, Inject, Injectable, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import type { IWhereBuilder, OrmDriver } from '@spinajs/orm';
import { randomUUID } from 'node:crypto';

import { AssignmentStore } from '../contracts.js';
import { AUTHZ_ASSIGNMENT_TABLE, rowToAssignment } from './assignment-row.js';
import type { AssignmentRow } from './assignment-row.js';
import { scopeToColumns, subjectToColumns } from './columns.js';
import type { SubjectColumns } from './columns.js';
import { storeConnection, storeDomain, storeTransactionDriver } from './context.js';
import { isUniqueViolation, pageWindow, whereLive } from './queries.js';
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
  readonly page?: { readonly limit: number; readonly offset: number };
}

/** The most rows one `list` call returns, with or without a page. */
export const ASSIGNMENT_LIST_MAX_LIMIT = 1000;

// One bound parameter per subject plus two per (type, role) group: far below SQLite's 999.
const SUBJECT_BATCH = 250;
const ID_BATCH = 500;
const TAG_RETRIES = 5;

/**
 * `AssignmentStore` over `authz_assignment` (design §9.1). Reads use the `authz.rbac.connection`
 * connection; writes run on the `AuthzTx` of `AuthzAdmin` and bump `authz_version` of the
 * store's domain in that transaction (B27).
 */
@PerChildInstance()
@Injectable(AssignmentStore)
@Inject(Container)
export class DbAssignmentStore extends AssignmentStore {
  readonly name: string = 'DbAssignmentStore';

  protected readonly subjectBatch: number = SUBJECT_BATCH;
  protected readonly maxListLimit: number = ASSIGNMENT_LIST_MAX_LIMIT;

  constructor(protected readonly container: IContainer) {
    super();
  }

  async forSubjects(subjects: readonly AssignmentSubject[], at: Date): Promise<readonly Assignment[]> {
    if (subjects.length === 0) return [];

    const keys = uniqueSubjects(subjects);
    const driver = await this.connection();
    const out: Assignment[] = [];

    for (let i = 0; i < keys.length; i += this.subjectBatch) {
      const batch = keys.slice(i, i + this.subjectBatch);
      const query = driver.select().from(AUTHZ_ASSIGNMENT_TABLE);
      whereSubjects(query, batch);
      whereLive(query, at);
      out.push(...(await rowsOf(query)).map(rowToAssignment));
    }

    return out;
  }

  async holders(role: string, scope: ResourceRef, at: Date): Promise<readonly AssignmentSubject[]> {
    const driver = await this.connection();
    const query = driver.select().from(AUTHZ_ASSIGNMENT_TABLE).where('role', role).where(scopeToColumns(scope));
    whereLive(query, at);

    return (await rowsOf(query)).map((r) => rowToAssignment(r).subject);
  }

  async byId(id: string): Promise<Assignment | null> {
    const row = await rowById(await this.connection(), id);
    return row ? rowToAssignment(row) : null;
  }

  /** Grants, or updates tags, expiry and grantor of the existing (subject, role, scope) row, keeping its id. */
  async assign(a: Omit<Assignment, 'id' | 'source'>, actor: PrincipalRef, tx: AuthzTx): Promise<Assignment> {
    const driver = await this.writeDriver(tx, `${this.name}.assign`);
    const key = { ...subjectToColumns(a.subject), role: a.role, ...scopeToColumns(a.scope) };
    const change = { tags: normaliseTags(a.tags), expires_at: a.expiresAt ?? null, granted_by: principalKey(actor) };

    const existing = await this.existingRow(driver, key);
    let row: AssignmentRow;

    if (existing) {
      await driver.update().in(AUTHZ_ASSIGNMENT_TABLE).update(change).where('id', existing.id);
      row = { ...existing, ...change };
    } else {
      row = { id: randomUUID(), ...key, ...change, source: 'db', created_at: this.now() };
      try {
        await driver.insert().into(AUTHZ_ASSIGNMENT_TABLE).values(row);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        throw new AuthzAdminFailure('conflict', `${this.name}.assign: another transaction granted ${a.role} to the same subject at the same scope; retry`, undefined, { cause: err });
      }
    }

    await bumpVersion(driver, this.domain());
    return rowToAssignment(row);
  }

  /** Unknown id ⇒ `AuthzAdminFailure('not_found')`. */
  async revoke(id: string, _actor: PrincipalRef, tx: AuthzTx): Promise<void> {
    const driver = await this.writeDriver(tx, `${this.name}.revoke`);
    await requireRow(driver, id);
    await driver.del().from(AUTHZ_ASSIGNMENT_TABLE).where('id', id);
    await bumpVersion(driver, this.domain());
  }

  /** Replaces the tags (`assignment.setTags`); returns the updated assignment. */
  async setTags(id: string, tags: readonly string[], tx: AuthzTx): Promise<Assignment> {
    const driver = await this.writeDriver(tx, `${this.name}.setTags`);
    const text = normaliseTags(tags);
    const row = await requireRow(driver, id);
    await driver.update().in(AUTHZ_ASSIGNMENT_TABLE).update({ tags: text }).where('id', id);
    await bumpVersion(driver, this.domain());
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

  /** Sets or clears (`null`) the expiry (`assignment.setExpiry`); returns the updated assignment. */
  async setExpiry(id: string, expiresAt: Date | null, tx: AuthzTx): Promise<Assignment> {
    const driver = await this.writeDriver(tx, `${this.name}.setExpiry`);
    const row = await requireRow(driver, id);
    await driver
      .update()
      .in(AUTHZ_ASSIGNMENT_TABLE)
      .update({ expires_at: expiresAt ?? null })
      .where('id', id);
    await bumpVersion(driver, this.domain());
    return rowToAssignment({ ...row, expires_at: expiresAt ?? null });
  }

  /** Deletes the rows at `scope` matching `subject` and `role`, expired ones too (`assignment.revokeWhere`); returns them. */
  async revokeWhere(filter: AssignmentFilter, tx: AuthzTx): Promise<readonly Assignment[]> {
    const driver = await this.writeDriver(tx, `${this.name}.revokeWhere`);
    return this.deleteWhere(driver, (query) => whereFilter(query, filter));
  }

  /**
   * `scope.forget`: deletes every row AT `scope` (not below it) and every grant whose subject is a
   * set living at `scope`, wherever it is held, so a later scope with the same id inherits nothing.
   * Returns them. GLOBAL and type-level refs are refused (`wrong_scope_type`).
   */
  async forgetScope(scope: ResourceRef, tx: AuthzTx): Promise<readonly Assignment[]> {
    if (scope.type === GLOBAL.type || !scope.id) {
      throw new AuthzAdminFailure('wrong_scope_type', `${this.name}.forgetScope: only a scope node can be forgotten, not ${scope.type === GLOBAL.type ? 'GLOBAL' : `the type-level ref ${scope.type}`}`, 'scope');
    }

    const driver = await this.writeDriver(tx, `${this.name}.forgetScope`);
    const columns = scopeToColumns(scope);
    return this.deleteWhere(driver, (query) =>
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
   */
  async list(q: AssignmentListQuery, at: Date): Promise<{ items: readonly Assignment[]; total: number }> {
    const { limit, offset } = pageWindow(q.page, this.maxListLimit, `${this.name}.list`);

    const driver = await this.connection();
    const filtered = () => {
      const query = driver.select().from(AUTHZ_ASSIGNMENT_TABLE);
      whereFilter(query, q);
      if (!q.includeExpired) whereLive(query, at);
      return query;
    };

    const total = Number(await filtered().selectCount());
    if (limit === 0) return { items: [], total };

    const query = filtered().orderBy('created_at').orderBy('id').take(limit);
    if (offset > 0) query.skip(offset);

    return { items: (await rowsOf(query)).map(rowToAssignment), total };
  }

  protected connection(): Promise<OrmDriver> {
    return storeConnection(this.container);
  }

  /** The driver of `tx`, which must be a transaction on {@link connection}. */
  protected async writeDriver(tx: AuthzTx, where: string): Promise<OrmDriver> {
    return storeTransactionDriver(tx, await this.connection(), where);
  }

  protected async existingRow(driver: OrmDriver, key: Record<string, string>): Promise<AssignmentRow | undefined> {
    const [row] = await rowsOf(driver.select().from(AUTHZ_ASSIGNMENT_TABLE).where(key));
    return row;
  }

  protected domain(): string {
    return storeDomain(this.container);
  }

  protected now(): Date {
    return this.container.hasRegistered(AuthzClock) ? this.container.resolve(AuthzClock).now() : new Date();
  }

  /** Read-modify-write guarded by the old tags, so a concurrent change is retried instead of lost. */
  private async changeTags(id: string, tx: AuthzTx, where: string, change: (current: string[]) => string[]): Promise<Assignment> {
    const driver = await this.writeDriver(tx, where);

    for (let attempt = 1; ; attempt++) {
      const row = await requireRow(driver, id);
      const tags = normaliseTags(change(parseTags(row.tags)));
      const result = await driver.update().in(AUTHZ_ASSIGNMENT_TABLE).update({ tags }).where('id', id).where('tags', row.tags);

      if (rowsAffected(result) > 0) {
        await bumpVersion(driver, this.domain());
        return rowToAssignment({ ...row, tags });
      }

      if (attempt >= TAG_RETRIES) {
        throw new AuthzAdminFailure('conflict', `${where}: the tags of assignment ${id} kept changing concurrently`);
      }
    }
  }

  private async deleteWhere(driver: OrmDriver, where: (query: IWhereBuilder<unknown>) => void): Promise<readonly Assignment[]> {
    const query = driver.select().from(AUTHZ_ASSIGNMENT_TABLE);
    where(query);
    const rows = await rowsOf(query);

    for (let i = 0; i < rows.length; i += ID_BATCH) {
      await driver
        .del()
        .from(AUTHZ_ASSIGNMENT_TABLE)
        .whereIn(
          'id',
          rows.slice(i, i + ID_BATCH).map((r) => r.id),
        );
    }

    await bumpVersion(driver, this.domain());
    return rows.map(rowToAssignment);
  }
}

function uniqueSubjects(subjects: readonly AssignmentSubject[]): SubjectColumns[] {
  const seen = new Map<string, SubjectColumns>();
  for (const s of subjects) {
    const c = subjectToColumns(s);
    seen.set(JSON.stringify([c.subject_type, c.subject_id, c.subject_role]), c);
  }
  return [...seen.values()];
}

/** `(type = ? AND role = ? AND id IN (…)) OR …`, one group per (type, role); row-value `IN` is not portable. */
function whereSubjects(query: IWhereBuilder<unknown>, subjects: readonly SubjectColumns[]): void {
  const groups = new Map<string, { type: string; role: string; ids: string[] }>();
  for (const s of subjects) {
    const key = JSON.stringify([s.subject_type, s.subject_role]);
    const group = groups.get(key) ?? { type: s.subject_type, role: s.subject_role, ids: [] };
    group.ids.push(s.subject_id);
    groups.set(key, group);
  }

  query.where(function () {
    for (const g of groups.values()) {
      this.orWhere(function () {
        this.where('subject_type', g.type).where('subject_role', g.role).whereIn('subject_id', g.ids);
      });
    }
  });
}

function whereFilter(query: IWhereBuilder<unknown>, filter: { scope?: ResourceRef; subject?: AssignmentSubject; role?: string }): void {
  if (filter.scope) query.where(scopeToColumns(filter.scope));
  if (filter.subject) query.where(subjectToColumns(filter.subject));
  if (filter.role !== undefined) query.where('role', filter.role);
}

async function rowsOf(query: PromiseLike<unknown>): Promise<AssignmentRow[]> {
  return (await query) as AssignmentRow[];
}

async function rowById(driver: OrmDriver, id: string): Promise<AssignmentRow | undefined> {
  const [row] = await rowsOf(driver.select().from(AUTHZ_ASSIGNMENT_TABLE).where('id', id));
  return row;
}

async function requireRow(driver: OrmDriver, id: string): Promise<AssignmentRow> {
  const row = await rowById(driver, id);
  if (!row) throw new AuthzAdminFailure('not_found', `Assignment ${JSON.stringify(id)} does not exist`, 'id');
  return row;
}

function rowsAffected(result: unknown): number {
  return Number((result as { RowsAffected?: unknown } | undefined)?.RowsAffected ?? 0);
}
