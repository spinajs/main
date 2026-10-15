import { AccessDenied, AuthzClock, FALSE, authz, currentPrincipal } from '@spinajs/authz';
import type { AuthzService, Decision, DenyReason, Permission, Principal, ResourceType } from '@spinajs/authz';
import { Injectable } from '@spinajs/di';
import { QueryMiddleware, RawQuery, SelectQueryBuilder } from '@spinajs/orm';
import type { IQueryStatement, IWhereBuilder, QueryBuilder } from '@spinajs/orm';

import { auditUnscoped, domainContainer, ormDomain } from '../host.js';
import { marksOf } from '../marker.js';
import type { AccessMarks } from '../marker.js';
import { entryOf } from '../registry.js';
import type { ResourceEntry } from '../registry.js';
import { AccessFieldMiddleware, accessColumn, accessField } from './access-field.js';
import { rowContext } from './context.js';
import { quoterOf } from './dialect.js';
import { renderPlan } from './render.js';
import type { Rendered } from './render.js';

type Where = IWhereBuilder<unknown>;
type Statements = { _statements: IQueryStatement[] };

async function nowOf(domain: string): Promise<Date> {
  const c = domainContainer(domain);
  return c.hasRegistered(AuthzClock) ? ((await c.resolve(AuthzClock)) as AuthzClock).now() : new Date();
}

function denied(domain: string, principal: Principal, permission: Permission, type: ResourceType, reason: DenyReason): Decision {
  return Object.freeze({ allowed: false, permission, resource: Object.freeze({ type }), principal: Object.freeze({ type: principal.type, id: principal.id }), residual: FALSE, fields: Object.freeze({ read: Object.freeze([]), write: Object.freeze([]) }), roles: Object.freeze({}), reason, domain });
}

/**
 * The ORM joins where statements without grouping them, so `(caller) AND (plan)` needs the caller's
 * statements moved into one group first; HAVING statements stay where they are.
 */
export function restrict(query: QueryBuilder, rendered: Extract<Rendered, { kind: 'sql' }>): void {
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
  where.where(RawQuery.create(rendered.sql, [...rendered.bindings]));
  statements.push(...aggregates);
}

export interface ListRun {
  readonly domain: string;
  readonly principal: Principal;
  readonly service: AuthzService;
  readonly entry: ResourceEntry;
  readonly marks: AccessMarks;
  readonly now: Date;
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
    if (marks.accessible === undefined && marks.withAccess === undefined) return;
    const run: ListRun = { domain, principal, service: authz(domain), entry, marks, now: await nowOf(domain) };
    const row = rowContext(query, entry, run.now);
    if (marks.accessible !== undefined) {
      const rendered = renderPlan(await run.service.accessPlan(principal, marks.accessible, entry.type, marks.env), row);
      if (rendered.kind === 'none') throw new AccessDenied(denied(domain, principal, marks.accessible, entry.type, rendered.reason));
      if (rendered.kind === 'sql') restrict(query, rendered);
    }
    if (marks.withAccess !== undefined && query instanceof SelectQueryBuilder) await this.withAccess(query, run, row);
  }

  protected async withAccess(query: SelectQueryBuilder, run: ListRun, row: ReturnType<typeof rowContext>): Promise<void> {
    const permissions = run.marks.withAccess ?? [];
    const q = quoterOf(query.Driver);
    if (query.getColumns().length === 0) query.select('*');
    for (const [i, permission] of permissions.entries()) {
      const r = renderPlan(await run.service.accessPlan(run.principal, permission, run.entry.type, run.marks.env), row);
      const expr = r.kind === 'none' ? { sql: '0', bindings: [] as unknown[] } : r.kind === 'all' ? { sql: '1', bindings: [] as unknown[] } : { sql: `CASE WHEN ${r.sql} THEN 1 ELSE 0 END`, bindings: [...r.bindings] };
      query.select(RawQuery.create(`${expr.sql} AS ${q(accessColumn(i))}`, expr.bindings));
    }
    query.middleware(new AccessFieldMiddleware(permissions, accessField()));
  }
}
