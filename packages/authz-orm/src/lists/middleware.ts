import { AccessDenied, AuthzConfigError, FALSE, authz, authzStorage, currentPrincipal } from '@spinajs/authz';
import type { AuthzService, Decision, DenyReason, Permission, Principal, ResourceType } from '@spinajs/authz';
import { Injectable } from '@spinajs/di';
import { DeleteQueryBuilder, QueryMiddleware, SelectQueryBuilder, UpdateQueryBuilder, WhereBuilder, captureReadScope, createQuery, extractModelDescriptor, relationSyncOf, supportsRowLocks } from '@spinajs/orm';
import type { IQueryStatement, IWhereBuilder, QueryBuilder } from '@spinajs/orm';

import { auditUnscoped, ormDomain, ormLog } from '../host.js';
import { marksOf } from '../marker.js';
import type { AccessMarks } from '../marker.js';
import type { PlanRow } from '../plan/index.js';
import { entryOf, nameOf } from '../registry.js';
import type { ResourceEntry } from '../registry.js';
import { AccessFieldMiddleware, accessColumn, accessField } from './access-field.js';
import { applyWithin, planFilter } from './render.js';
import { RowFieldsMiddleware, fieldConditions, fieldsColumn } from './row-fields.js';
import { planRow } from './row.js';

type Where = IWhereBuilder<unknown>;
type Statements = { _statements: IQueryStatement[] };
type Filter = (where: Where) => void;
type Sync = NonNullable<ReturnType<typeof relationSyncOf>>;
type SyncStatement = UpdateQueryBuilder<unknown> | DeleteQueryBuilder<unknown>;

interface ListFilters {
  readonly filters: Filter[];
  /** The plan of `.accessible()` added a filter, as opposed to `.within()` alone. */
  readonly byPlan: boolean;
}

/** A filtered sync() statement, checked after it ran. */
interface SyncCheck {
  readonly statement: SyncStatement;
  readonly sync: Sync;
  readonly run: ListRun;
  readonly byPlan: boolean;
  /** The statement's own conditions, without the filters. */
  readonly conditions: readonly IQueryStatement[];
}

function denied(domain: string, principal: Principal, permission: Permission, type: ResourceType, reason: DenyReason): Decision {
  return Object.freeze({ allowed: false, permission, resource: Object.freeze({ type }), principal: Object.freeze({ type: principal.type, id: principal.id }), residual: FALSE, fields: Object.freeze({ read: Object.freeze([]), write: Object.freeze([]) }), roles: Object.freeze({}), reason, domain });
}

/**
 * The ORM joins where statements without grouping them, so `(caller) AND (filters)` needs the caller's
 * statements moved into one group first; HAVING statements stay where they are. `apply` runs before the
 * query changes, so a filter that throws leaves the query as the caller wrote it.
 */
export function restrict(query: QueryBuilder, apply: (where: Where) => void): void {
  const filters = detached(query, apply);
  const statements = (query as unknown as Statements)._statements;
  const isAggregate = (s: IQueryStatement) => (s as { IsAggregate?: boolean }).IsAggregate === true;
  const callers = statements.filter((s) => !isAggregate(s));
  const aggregates = statements.filter(isAggregate);
  statements.length = 0;
  const where = query as unknown as Where;
  if (callers.length > 0) {
    where.where(function (this: Where) {
      (this as unknown as Statements)._statements.push(...callers);
    } as never);
  }
  statements.push(...filters.Statements, ...aggregates);
}

/** Conditions built in a group of `query` that is not attached to it yet. */
function detached(query: QueryBuilder, apply: (where: Where) => void): Where {
  const where = new WhereBuilder<unknown>(query as never);
  apply(where);
  return where;
}

/** One restrict: the caller's where becomes one group, ANDed with every filter. */
function restrictAll(query: QueryBuilder, filters: readonly Filter[]): void {
  restrict(query, (where) => {
    for (const apply of filters) {
      where.where(function () {
        apply(this);
      });
    }
  });
}

/** The update or delete a relation list's sync() built itself, undefined for any other builder. */
function syncOf(query: QueryBuilder): { readonly statement: SyncStatement; readonly sync: Sync } | undefined {
  if (!(query instanceof UpdateQueryBuilder || query instanceof DeleteQueryBuilder)) return undefined;
  const sync = relationSyncOf(query);
  return sync === undefined ? undefined : { statement: query, sync };
}

function cloneInto(parent: QueryBuilder, statement: IQueryStatement): IQueryStatement {
  const c = statement.clone(parent);
  c.Boolean = statement.Boolean;
  return c;
}

/**
 * The keys of the rows `conditions` still reach in the model of `query`, read as the write capture reads a write's
 * keys: as SYSTEM, so no guard or list fires on the read, soft-deleted and archived rows included, on the statement's
 * connection and so in its transaction, in the database the statement names, with these conditions only (none a middleware added to the select at creation).
 * A locking read: under MySQL REPEATABLE READ a plain one returns the transaction's snapshot and misses a row another
 * transaction committed after it. No aggregate, as PostgreSQL refuses one with a row lock.
 */
function rowsLeft(query: SyncStatement, conditions: readonly IQueryStatement[], limit?: number): Promise<unknown[]> {
  const model = query.Model;
  if (!model) throw new AuthzConfigError('authz-orm: a sync() statement without a model cannot be counted');
  return captureReadScope().run(async () => {
    const { query: select } = createQuery(model, SelectQueryBuilder, true, query.Driver);
    if (query.Database) select.database(query.Database);
    select.withDeleted().withArchived().onPrimary();
    // MSSQL has no row lock clause; its READ COMMITTED reads see committed rows anyway.
    if (supportsRowLocks(query.Driver)) select.forShare();
    select.Statements.splice(0, select.Statements.length, ...conditions.map((s) => cloneInto(select, s)));
    const keys = extractModelDescriptor(model)?.PrimaryKey ?? [];
    if (keys.length > 0) select.columns(keys);
    if (limit !== undefined) select.take(limit);
    return select.asRaw<unknown[]>();
  });
}

export interface ListRun {
  readonly domain: string;
  readonly principal: Principal;
  readonly service: AuthzService;
  readonly entry: ResourceEntry;
  readonly marks: AccessMarks;
}

/** Plans `.accessible()` / `.withAccess()` at execution, for the principal the query runs as. */
@Injectable(QueryMiddleware)
export class AccessListMiddleware extends QueryMiddleware {
  public order = 100;

  private readonly syncChecks = new WeakMap<QueryBuilder, SyncCheck>();

  afterQueryCreation(_query: QueryBuilder): void {}

  async beforeQueryExecution(query: QueryBuilder): Promise<void> {
    const marks = marksOf(query);
    if (marks === undefined) return;
    const entry = entryOf(query.Model);
    if (!entry) return;
    const domain = ormDomain();
    const principal = currentPrincipal();
    if (marks.unscoped !== undefined) auditUnscoped(domain, principal, marks.unscoped, entry.type);
    if (marks.accessible === undefined && marks.withAccess === undefined && marks.within === undefined && marks.withFields === undefined) return;
    const run: ListRun = { domain, principal, service: authz(domain), entry, marks };
    const row = planRow(query, entry);
    const sync = syncOf(query);
    const { filters, byPlan } = await this.filters(run, row, sync !== undefined);
    // Every condition is compiled before the first change to the query.
    const access = marks.withAccess !== undefined && query instanceof SelectQueryBuilder ? await this.accessConditions(query, run, row) : undefined;
    const fields = query instanceof SelectQueryBuilder ? await this.fieldConditions(query, run, row) : undefined;
    if (sync !== undefined && filters.length > 0) this.syncChecks.set(query, { ...sync, run, byPlan, conditions: sync.statement.Statements.map((s) => cloneInto(query, s)) });
    // One restrict: the caller's where becomes one group, ANDed with the plan and every .within().
    if (filters.length > 0) restrictAll(query, filters);
    if (access !== undefined) this.withAccess(query as SelectQueryBuilder, run, access);
    if (fields !== undefined) this.withFields(query as SelectQueryBuilder, fields);
  }

  /**
   * A filtered sync() statement must have reached every row of its own conditions: the delete removed them, and the
   * soft-delete stamp's `whereNull(<deleted_at>)` no longer matches the rows it stamped. A row still reached was kept
   * by a filter, or was changed or inserted by another transaction before the read; either way the sync() would be
   * partial, so it is refused and its transaction rolls back. The rows left are counted only for the refusal's log.
   */
  async afterQueryExecution(query: QueryBuilder): Promise<void> {
    const check = this.syncChecks.get(query);
    if (check === undefined) return;
    this.syncChecks.delete(query);
    if ((await rowsLeft(check.statement, check.conditions, 1)).length === 0) return;
    this.refusePartialSync(check, (await rowsLeft(check.statement, check.conditions)).length);
  }

  /** The plan of `.accessible()` and every `.within()`; inside a sync() a `none` plan is AccessDenied whatever `onNone` says. */
  protected async filters(run: ListRun, row: PlanRow, inSync: boolean): Promise<ListFilters> {
    const { marks } = run;
    const filters: Filter[] = [];
    if (marks.accessible !== undefined) {
      const filter = planFilter(await run.service.accessPlan(run.principal, marks.accessible, run.entry.type, marks.env), row);
      if (filter.kind === 'none') {
        if (marks.onNone !== 'empty' || inSync) throw new AccessDenied(denied(run.domain, run.principal, marks.accessible, run.entry.type, filter.reason));
        filters.push((where) => where.where(false));
      } else if (filter.kind === 'where') filters.push(filter.apply);
    }
    const byPlan = filters.length > 0;
    for (const refs of marks.within ?? []) filters.push((where) => applyWithin(where, refs, row));
    return { filters, byPlan };
  }

  /**
   * With a plan filter the refusal is the standard AccessDenied, whose message can reach a 403 body, so what was left
   * goes to the log only. Without one, the application's own `.within()` narrowed the sync(): a configuration error.
   */
  protected refusePartialSync(check: SyncCheck, left: number): never {
    const { run, sync } = check;
    const owner = nameOf(sync.owner);
    const model = nameOf(check.statement.Model);
    const permission = run.marks.accessible;
    if (!check.byPlan || permission === undefined) throw new AuthzConfigError(`authz-orm: .within() left ${model} rows behind in sync() of ${owner}.${sync.relation}; a sync() is never partial`);
    ormLog().warn({ owner, relation: sync.relation, model, permission, left }, 'authz-orm: sync() of ${owner}.${relation} under ${permission} left ${left} ${model} rows behind; refused with AccessDenied and rolled back');
    throw new AccessDenied(denied(run.domain, run.principal, permission, run.entry.type, { code: 'no_access' }));
  }

  /** `.withFields(p)`, or `.accessible(p)` under a `fields: 'filter-rows'` route (AuthzRowFields): one condition per plan atom. */
  protected async fieldConditions(query: SelectQueryBuilder, run: ListRun, row: PlanRow): Promise<{ conditions: Where[]; middleware: RowFieldsMiddleware } | undefined> {
    const permission = run.marks.withFields ?? (authzStorage().getStore()?.AuthzRowFields === true ? run.marks.accessible : undefined);
    if (permission === undefined) return undefined;
    const plan = await run.service.accessPlan(run.principal, permission, run.entry.type, run.marks.env);
    const applies = plan.kind === 'filter' ? fieldConditions(plan, row) : [];
    const conditions = applies.map((apply) => detached(query, apply));
    const request = { service: run.service, principal: run.principal, permission, type: run.entry.type, idColumn: run.entry.idColumn, ...(plan.kind === 'none' ? { none: true } : {}) };
    return { conditions, middleware: new RowFieldsMiddleware(conditions.length, request) };
  }

  protected withFields(query: SelectQueryBuilder, fields: { conditions: readonly Where[]; middleware: RowFieldsMiddleware }): void {
    if (query.getColumns().length === 0) query.select('*');
    for (const [i, condition] of fields.conditions.entries()) {
      query.selectCondition(fieldsColumn(i), function () {
        this.Statements.push(...condition.Statements);
      });
    }
    query.middleware(fields.middleware);
  }

  /** One condition per `.withAccess()` permission, in order. */
  protected async accessConditions(query: SelectQueryBuilder, run: ListRun, row: PlanRow): Promise<Where[]> {
    const conditions: Where[] = [];
    for (const permission of run.marks.withAccess ?? []) {
      const filter = planFilter(await run.service.accessPlan(run.principal, permission, run.entry.type, run.marks.env), row);
      conditions.push(detached(query, (where) => (filter.kind === 'where' ? filter.apply(where) : where.where(filter.kind === 'all'))));
    }
    return conditions;
  }

  protected withAccess(query: SelectQueryBuilder, run: ListRun, conditions: readonly Where[]): void {
    const permissions = run.marks.withAccess ?? [];
    if (query.getColumns().length === 0) query.select('*');
    for (const [i, condition] of conditions.entries()) {
      query.selectCondition(accessColumn(i), function () {
        this.Statements.push(...condition.Statements);
      });
    }
    query.middleware(new AccessFieldMiddleware(permissions, accessField()));
  }
}
