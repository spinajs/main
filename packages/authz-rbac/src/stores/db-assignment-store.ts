import { AuthzAdminFailure, AuthzClock, GLOBAL, principalKey } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, AuthzTx, PrincipalRef, ResourceRef } from '@spinajs/authz';
import { Container, Inject, Injectable, PerChildInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import type { IWhereBuilder, OrmDriver } from '@spinajs/orm';
import { randomUUID } from 'node:crypto';

import { AdminAssignmentStore } from '../admin/ports.js';
import type { AssignmentQuery, Page } from '../admin/ports.js';
import { AUTHZ_ASSIGNMENT_TABLE, rowToAssignment } from './assignment-row.js';
import type { AssignmentRow } from './assignment-row.js';
import { SUBJECT_KEY_MAX_LENGTH, scopeToColumns, subjectKeyOf, subjectToColumns } from './columns.js';
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

// One bound parameter per subject key: far below SQLite's 999.
const SUBJECT_BATCH = 250;
const ID_BATCH = 500;
const TAG_RETRIES = 5;

/**
 * `AssignmentStore` over `authz_assignment` (design §9.1). Reads use the `authz.rbac.connection`
 * connection; writes run on the `AuthzTx` of `AuthzAdmin` and bump `authz_version` of the
 * store's domain in that transaction (B27). Registered by class name only; a domain uses it by
 * registering it as `AdminAssignmentStore` and `AssignmentStore`.
 */
@PerChildInstance()
@Injectable()
@Inject(Container)
export class DbAssignmentStore extends AdminAssignmentStore {
  readonly name: string = 'DbAssignmentStore';

  protected readonly subjectBatch: number = SUBJECT_BATCH;
  protected readonly maxListLimit: number = ASSIGNMENT_LIST_MAX_LIMIT;

  constructor(protected readonly container: IContainer) {
    super();
  }

  async forSubjects(subjects: readonly AssignmentSubject[], at: Date): Promise<readonly Assignment[]> {
    if (subjects.length === 0) return [];
    return (await this.rowsForKeys(await this.connection(), subjects.map(subjectKeyOf), at)).map(rowToAssignment);
  }

  async forSubjectKeys(keys: readonly string[], at: Date): Promise<readonly Assignment[]> {
    return (await this.rowsForKeys(await this.connection(), keys, at)).map(rowToAssignment);
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
    const subjectKey = subjectKeyOf(a.subject);
    if (subjectKey.length > SUBJECT_KEY_MAX_LENGTH) {
      throw new AuthzAdminFailure('invalid_command', `${this.name}.assign: the subject key ${JSON.stringify(subjectKey.slice(0, 40))}… is longer than ${SUBJECT_KEY_MAX_LENGTH} characters`, 'subject');
    }
    const change = { tags: normaliseTags(a.tags), expires_at: a.expiresAt ?? null, granted_by: principalKey(actor) };

    const existing = await this.existingRow(driver, key);
    let row: AssignmentRow;

    if (existing) {
      await driver.update().in(AUTHZ_ASSIGNMENT_TABLE).update(change).where('id', existing.id);
      row = { ...existing, ...change };
    } else {
      row = { id: randomUUID(), ...key, subject_key: subjectKey, ...change, source: 'db', created_at: this.now() };
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

  /** `AdminAssignmentStore.update`: the tags and/or expiry given, in one write and one bump. */
  async update(id: string, patch: { readonly tags?: readonly string[]; readonly expiresAt?: Date | null }, _actor: PrincipalRef, tx: AuthzTx): Promise<Assignment> {
    const driver = await this.writeDriver(tx, `${this.name}.update`);
    const change: Partial<AssignmentRow> = {};
    if (patch.tags !== undefined) change.tags = normaliseTags(patch.tags);
    if (patch.expiresAt !== undefined) change.expires_at = patch.expiresAt;

    const row = await requireRow(driver, id);
    if (Object.keys(change).length > 0) await driver.update().in(AUTHZ_ASSIGNMENT_TABLE).update(change).where('id', id);
    await bumpVersion(driver, this.domain());
    return rowToAssignment({ ...row, ...change });
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

  /** Deletes every row of `subjects` at any scope, expired ones too (a revoked share link); returns them. */
  async revokeSubjects(subjects: readonly AssignmentSubject[], tx: AuthzTx): Promise<readonly Assignment[]> {
    const driver = await this.writeDriver(tx, `${this.name}.revokeSubjects`);
    return this.deleteRows(driver, await this.rowsForKeys(driver, subjects.map(subjectKeyOf), undefined));
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
    return this.select(q, at, pageWindow(q.page, this.maxListLimit, `${this.name}.list`));
  }

  /**
   * `AdminAssignmentStore.find` with `q.at` as now. With a page, as {@link list}; without one, every
   * match in one query: AuthzAdmin's guard reads that as the full set (escalation, self-lockout).
   */
  async find(q: AssignmentQuery, page?: Page): Promise<{ items: readonly Assignment[]; total: number }> {
    const { at, ...filter } = q;
    return this.select(filter, at, page ? pageWindow(page, this.maxListLimit, `${this.name}.find`) : undefined);
  }

  protected connection(): Promise<OrmDriver> {
    return storeConnection(this.container);
  }

  /** Rows of these subject keys, in batches; `at` undefined keeps expired rows. */
  private async rowsForKeys(driver: OrmDriver, keys: readonly string[], at: Date | undefined): Promise<AssignmentRow[]> {
    const unique = [...new Set(keys)];
    const out: AssignmentRow[] = [];
    for (let i = 0; i < unique.length; i += this.subjectBatch) {
      const query = driver
        .select()
        .from(AUTHZ_ASSIGNMENT_TABLE)
        .whereIn('subject_key', unique.slice(i, i + this.subjectBatch));
      if (at) whereLive(query, at);
      out.push(...(await rowsOf(query)));
    }
    return out;
  }

  /** The filtered rows, oldest first; `window` undefined reads every match in one query. */
  private async select(q: Omit<AssignmentListQuery, 'page'>, at: Date, window: { limit: number; offset: number } | undefined): Promise<{ items: readonly Assignment[]; total: number }> {
    const driver = await this.connection();
    const filtered = () => {
      const query = driver.select().from(AUTHZ_ASSIGNMENT_TABLE);
      whereFilter(query, q);
      if (!q.includeExpired) whereLive(query, at);
      return query;
    };

    if (!window) {
      const items = (await rowsOf(filtered().orderBy('created_at').orderBy('id'))).map(rowToAssignment);
      return { items, total: items.length };
    }

    const total = Number(await filtered().selectCount());
    if (window.limit === 0) return { items: [], total };

    const query = filtered().orderBy('created_at').orderBy('id').take(window.limit);
    if (window.offset > 0) query.skip(window.offset);

    return { items: (await rowsOf(query)).map(rowToAssignment), total };
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
    return this.deleteRows(driver, await rowsOf(query));
  }

  private async deleteRows(driver: OrmDriver, rows: readonly AssignmentRow[]): Promise<readonly Assignment[]> {
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
