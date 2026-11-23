import { NotSupported } from '@spinajs/exceptions';
import { RelationType } from '@spinajs/orm';
import type { SelectQueryBuilder } from '@spinajs/orm';

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
