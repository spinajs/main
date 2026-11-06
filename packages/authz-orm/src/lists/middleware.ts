import { AccessDenied, FALSE, authz, authzStorage, currentPrincipal } from '@spinajs/authz';
import type { AuthzService, Decision, DenyReason, Permission, Principal, ResourceType } from '@spinajs/authz';
import { Injectable } from '@spinajs/di';
import { QueryMiddleware, SelectQueryBuilder, WhereBuilder } from '@spinajs/orm';
import type { IQueryStatement, IWhereBuilder, QueryBuilder } from '@spinajs/orm';

import { auditUnscoped, ormDomain } from '../host.js';
import { marksOf } from '../marker.js';
import type { AccessMarks } from '../marker.js';
import type { PlanRow } from '../plan/index.js';
import { entryOf } from '../registry.js';
import type { ResourceEntry } from '../registry.js';
import { AccessFieldMiddleware, accessColumn, accessField } from './access-field.js';
import { applyWithin, planFilter } from './render.js';
import { RowFieldsMiddleware, fieldConditions, fieldsColumn } from './row-fields.js';
import { planRow } from './row.js';

type Where = IWhereBuilder<unknown>;
type Statements = { _statements: IQueryStatement[] };

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
    const filters: ((where: Where) => void)[] = [];
    if (marks.accessible !== undefined) {
      const filter = planFilter(await run.service.accessPlan(principal, marks.accessible, entry.type, marks.env), row);
      if (filter.kind === 'none') {
        if (marks.onNone !== 'empty') throw new AccessDenied(denied(domain, principal, marks.accessible, entry.type, filter.reason));
        filters.push((where) => where.where(false));
      } else if (filter.kind === 'where') filters.push(filter.apply);
    }
    for (const refs of marks.within ?? []) filters.push((where) => applyWithin(where, refs, row));
    // Every condition is compiled before the first change to the query.
    const access = marks.withAccess !== undefined && query instanceof SelectQueryBuilder ? await this.accessConditions(query, run, row) : undefined;
    const fields = query instanceof SelectQueryBuilder ? await this.fieldConditions(query, run, row) : undefined;
    // One restrict: the caller's where becomes one group, ANDed with the plan and every .within().
    if (filters.length > 0) {
      restrict(query, (where) => {
        for (const apply of filters) {
          where.where(function () {
            apply(this);
          });
        }
      });
    }
    if (access !== undefined) this.withAccess(query as SelectQueryBuilder, run, access);
    if (fields !== undefined) this.withFields(query as SelectQueryBuilder, fields);
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
