import { AccessDenied, AuthzConfigError, FALSE, authz, authzStorage, currentPrincipal } from '@spinajs/authz';
import type { AuthzService, Decision, DenyReason, Permission, Principal, ResourceType } from '@spinajs/authz';
import { Injectable } from '@spinajs/di';
import { DeleteQueryBuilder, QueryMiddleware, SelectQueryBuilder, UpdateQueryBuilder, WhereBuilder, captureReadScope, createQuery, relationSyncOf } from '@spinajs/orm';
import type { IQueryStatement, IWhereBuilder, QueryBuilder } from '@spinajs/orm';

import { auditUnscoped, ormDomain } from '../host.js';
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
type SyncStatement = UpdateQueryBuilder<unknown> | DeleteQueryBuilder<unknown>;
type Sync = NonNullable<ReturnType<typeof relationSyncOf>>;

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

/**
 * The rows `query` reaches with `filters` added, counted as the write capture reads a write's keys: as SYSTEM, so no
 * guard or list fires on the count, soft-deleted and archived rows included, on the statement's connection and so in
 * its transaction.
 */
function reach(query: SyncStatement, filters: readonly Filter[]): Promise<number> {
  const model = query.Model;
  if (!model) throw new AuthzConfigError('authz-orm: a sync() statement without a model cannot be counted');
  return captureReadScope().run(async () => {
    const { query: select } = createQuery(model, SelectQueryBuilder, true, query.Driver);
    select.withDeleted().withArchived().onPrimary();
    for (const s of query.Statements) {
      const c = s.clone(select);
      c.Boolean = s.Boolean;
      select.Statements.push(c);
    }
    if (filters.length > 0) restrictAll(select, filters);
    return select.selectCount();
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
    const filters = await this.filters(run, row, sync !== undefined);
    if (sync !== undefined && filters.length > 0) await this.refuseNarrowedSync(sync.statement, sync.sync, run, filters);
    // Every condition is compiled before the first change to the query.
    const access = marks.withAccess !== undefined && query instanceof SelectQueryBuilder ? await this.accessConditions(query, run, row) : undefined;
    const fields = query instanceof SelectQueryBuilder ? await this.fieldConditions(query, run, row) : undefined;
    // One restrict: the caller's where becomes one group, ANDed with the plan and every .within().
    if (filters.length > 0) restrictAll(query, filters);
    if (access !== undefined) this.withAccess(query as SelectQueryBuilder, run, access);
    if (fields !== undefined) this.withFields(query as SelectQueryBuilder, fields);
  }

  /** The plan of `.accessible()` and every `.within()`; inside a sync() a `none` plan is AccessDenied whatever `onNone` says. */
  protected async filters(run: ListRun, row: PlanRow, inSync: boolean): Promise<Filter[]> {
    const { marks } = run;
    const filters: Filter[] = [];
    if (marks.accessible !== undefined) {
      const filter = planFilter(await run.service.accessPlan(run.principal, marks.accessible, run.entry.type, marks.env), row);
      if (filter.kind === 'none') {
        if (marks.onNone !== 'empty' || inSync) throw new AccessDenied(denied(run.domain, run.principal, marks.accessible, run.entry.type, filter.reason));
        filters.push((where) => where.where(false));
      } else if (filter.kind === 'where') filters.push(filter.apply);
    }
    for (const refs of marks.within ?? []) filters.push((where) => applyWithin(where, refs, row));
    return filters;
  }

  /**
   * A sync() statement the filters would narrow leaves the rows they drop behind without a sign, so it is refused
   * instead: two counts of the statement's own conditions, without and with the filters.
   */
  protected async refuseNarrowedSync(query: SyncStatement, sync: Sync, run: ListRun, filters: readonly Filter[]): Promise<void> {
    const total = await reach(query, []);
    if (total === 0) return;
    const reached = await reach(query, filters);
    if (reached >= total) return;
    const what = `sync() of ${nameOf(sync.owner)}.${sync.relation} reaches ${total} ${nameOf(query.Model)} rows and`;
    const permission = run.marks.accessible;
    if (permission === undefined) throw new AuthzConfigError(`authz-orm: ${what} .within() keeps ${reached} of them; a sync() is never partial`);
    const by = run.marks.within === undefined ? permission : `${permission} with .within()`;
    throw new AccessDenied(denied(run.domain, run.principal, permission, run.entry.type, { code: 'no_access' }), `Access denied: ${permission} on ${run.entry.type}: ${what} ${by} allows ${reached} of them; a sync() is never partial`);
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
