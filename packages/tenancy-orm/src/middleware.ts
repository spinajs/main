import { Injectable } from '@spinajs/di';
import { NotSupported } from '@spinajs/exceptions';
import { DeleteQueryBuilder, InsertQueryBuilder, QueryMiddleware, SelectQueryBuilder, UpdateQueryBuilder } from '@spinajs/orm';
import type { QueryBuilder } from '@spinajs/orm';
import { TenantRequired, tenantScope } from '@spinajs/tenancy';
import type { TenantScope } from '@spinajs/tenancy';

import { confine } from './confine.js';
import { stamp } from './insert.js';
import { hasTenantModels, nameOf } from './registry.js';
import { acrossTenantsReason } from './marker.js';
import { keepTenantColumn, refuseJoinedTenantTables, refusePartlyFiltered, requireCondition } from './shapes.js';
import { isStatement, requireColumn, statementName, targetOf } from './target.js';
import type { TenantTarget } from './target.js';
import { keepOneScopePerTransaction } from './transaction.js';

/** `.acrossTenants(reason)` is the all-tenants scope of one statement. */
function statementScope(query: QueryBuilder): TenantScope | undefined {
  const reason = acrossTenantsReason(query);
  return reason === undefined ? tenantScope() : { kind: 'all', reason };
}

/** Row mode (T9): confines every statement built from a tenant model to the tenant scope it runs in. */
@Injectable(QueryMiddleware)
export class TenantScopeMiddleware extends QueryMiddleware {
  // Ahead of the authz middlewares (90 to 100): their filter then wraps a statement that is already confined.
  public order = 80;

  afterQueryCreation(_query: QueryBuilder): void {}

  beforeQueryExecution(query: QueryBuilder): void {
    if (!hasTenantModels() || !isStatement(query)) return;
    const scope = statementScope(query);
    const target = targetOf(query);
    if (target === undefined) {
      if (query instanceof SelectQueryBuilder) refuseJoinedTenantTables(query, scope);
      return;
    }
    keepOneScopePerTransaction(query, scope);
    const name = statementName(query, target.entry);
    if (scope === undefined) throw new TenantRequired(`tenancy-orm: ${name} needs a tenant scope: run it inside runInTenant(), or leave the scope with a declared reason`);
    if (!target.owned) {
      if (query instanceof UpdateQueryBuilder) keepTenantColumn(query, target.entry, scope);
      if (scope.kind === 'all') return;
      throw new NotSupported(`tenancy-orm: ${name} does not go through the model's own query, so it is not filtered by tenant yet (v4-td-03-row-mode-conformance); query ${nameOf(target.entry.model)} itself, or run it inside runAcrossTenants(reason)`);
    }
    this.confineStatement(query, target, scope);
  }

  /** A statement built from the tenant model on its own table, in a tenant or the all-tenants scope. */
  protected confineStatement(query: QueryBuilder, target: TenantTarget, scope: TenantScope): void {
    requireColumn(query, target.entry);
    if (query instanceof InsertQueryBuilder) {
      stamp(query, target.entry, scope);
      return;
    }
    if (query instanceof UpdateQueryBuilder) keepTenantColumn(query, target.entry, scope);
    if (scope.kind === 'all') return;
    if (query instanceof SelectQueryBuilder) refusePartlyFiltered(query, statementName(query, target.entry));
    if (query instanceof UpdateQueryBuilder) requireCondition(query, target.entry);
    if (query instanceof SelectQueryBuilder || query instanceof UpdateQueryBuilder || query instanceof DeleteQueryBuilder) confine(query, target.entry.column, scope.tenant.id);
  }
}
