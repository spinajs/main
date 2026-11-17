import { InvalidOperation, NotSupported } from '@spinajs/exceptions';
import { RelationType, extractModelDescriptor } from '@spinajs/orm';
import type { ISelectQueryBuilder, SelectQueryBuilder, UpdateQueryBuilder } from '@spinajs/orm';
import { TenantRequired } from '@spinajs/tenancy';
import type { TenantScope } from '@spinajs/tenancy';

import { nameOf, tenantModelOfTable } from './registry.js';
import type { TenantModelEntry } from './registry.js';

/**
 * Selects the tenant predicate would cover only in part: when the query compiles, after every hook, the ORM merges a
 * to-one relation's conditions into the main WHERE ungrouped, and builds the recursive member of a CTE without it.
 */
export function refusePartlyFiltered(query: SelectQueryBuilder, name: string): void {
  const toOne = query.Relations.find((relation) => relation.Descriptor.Type === RelationType.One);
  if (toOne !== undefined) {
    throw new NotSupported(`tenancy-orm: ${name} populates the to-one relation ${toOne.Name}, whose conditions are not filtered by tenant yet (v4-td-03-row-mode-conformance); load it in a query of its own, or run it inside runAcrossTenants(reason)`);
  }
  if (query.CteRecursive !== undefined) {
    throw new NotSupported(`tenancy-orm: ${name} is a recursive query, whose recursive part is not filtered by tenant yet (v4-td-03-row-mode-conformance); walk the tree with queries of its own, or run it inside runAcrossTenants(reason)`);
  }
}

/** Paths of the to-one relations populated on `query`, through chains of to-one relations, that join a tenant table. */
function joinedTenantTables(query: ISelectQueryBuilder, path: string, found: string[]): string[] {
  for (const relation of query.Relations) {
    // A to-many relation runs as a statement of its own and is confined, or refused, there.
    if (relation.Descriptor.Type !== RelationType.One) continue;
    const name = `${path}${relation.Name}`;
    relation.execute(function () {
      if (tenantModelOfTable(this.Table) !== undefined) found.push(name);
      else joinedTenantTables(this, `${name}.`, found);
    });
  }
  return found;
}

/**
 * B13, for a select that is not a tenant model's own (part 2 refuses every to-one populate there): a to-one populate is
 * a join on this statement, which the tenant predicate never reaches.
 */
export function refuseJoinedTenantTables(query: SelectQueryBuilder, scope: TenantScope | undefined): void {
  if (scope?.kind === 'all') return;
  const [path] = joinedTenantTables(query, '', []);
  if (path === undefined) return;
  const what = `populate('${path}') on ${nameOf(query.Model)}`;
  if (scope === undefined) throw new TenantRequired(`tenancy-orm: ${what} joins a tenant model and needs a tenant scope: run it inside runInTenant(), or leave the scope with a declared reason`);
  throw new NotSupported(`tenancy-orm: ${what} joins a tenant model on the same statement, and a joined table is not filtered by tenant yet (v4-td-03-row-mode-conformance); load it with a query of its own`);
}

// What a database may still take for the same column name: MySQL ignores letter case, accents and trailing spaces.
const folded = (name: string): string => name.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').trim();

/**
 * A row never changes its tenant. Inside a tenant, writing that tenant's own id is what archive() does with the whole
 * row. A key the database may resolve to the tenant column counts as it; on a model every key must be a declared column,
 * because no rule of ours knows every database's collation.
 */
export function keepTenantColumn(query: UpdateQueryBuilder<unknown>, entry: TenantModelEntry, scope: TenantScope): void {
  const keys = [...Object.keys(query.Value), ...query.Increments.keys()];
  const written = keys.filter((key) => folded(key) === folded(entry.column));
  const own = scope.kind === 'tenant' && written.every((key) => !query.Increments.has(key) && Reflect.get(query.Value, key) === scope.tenant.id);
  if (written.length > 0 && !own) {
    throw new InvalidOperation(`tenancy-orm: update of ${entry.table} writes the tenant column ${entry.column}; a row never changes its tenant`);
  }
  const declared = extractModelDescriptor(query.Model)?.Columns.map((column) => column.Name);
  const undeclared = declared === undefined ? undefined : keys.find((key) => !declared.includes(key));
  if (undeclared !== undefined) {
    throw new InvalidOperation(`tenancy-orm: update of ${entry.table} sets ${JSON.stringify(undeclared)}, which is not a declared column of ${nameOf(query.Model)}, so it cannot be shown to leave the tenant column alone`);
  }
}

/** The compiler refuses an update with no where clause; the tenant predicate must not stand in for one. */
export function requireCondition(query: UpdateQueryBuilder<unknown>, entry: TenantModelEntry): void {
  if (!query.hasCondition()) throw new InvalidOperation(`tenancy-orm: update of ${entry.table} has no where clause; add .where(true) to update every row of the tenant`);
}
