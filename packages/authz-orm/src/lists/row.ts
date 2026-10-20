import { Wrapper } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { AUTHZ_RESOURCE_ANCESTOR_TABLE } from '../ancestors/table.js';
import type { PlanRow } from '../plan/index.js';
import { namedRelation } from '../registry.js';
import type { ResourceEntry } from '../registry.js';

/** The row of `query` as plan terms see it; their sub-queries run on the query's connection. */
export function planRow(query: { readonly Driver: OrmDriver }, entry: ResourceEntry): PlanRow {
  const driver = query.Driver;
  const relation = (name: string): { column: string; typeColumn?: string } | undefined => {
    const columns: { column: string; typeColumn?: string } | undefined = name === 'owner' ? entry.owner : name === 'self' ? entry.self : namedRelation(entry, name);
    if (!columns) return undefined;
    return Object.freeze({ column: columns.column, ...(columns.typeColumn !== undefined ? { typeColumn: columns.typeColumn } : {}) });
  };
  return Object.freeze({
    type: entry.type,
    id: Wrapper.Text(entry.idColumn),
    relation,
    ancestorTable: AUTHZ_RESOURCE_ANCESTOR_TABLE,
    now: () => driver.now(),
    from: (table: string, alias: string) => driver.select<unknown>().from(table, alias),
  });
}
