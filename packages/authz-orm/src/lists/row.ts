import { Wrapper } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { AUTHZ_RESOURCE_ANCESTOR_TABLE } from '../ancestors/table.js';
import type { PlanRow } from '../plan/index.js';
import type { ResourceEntry } from '../registry.js';

/** The row of `query` as plan terms see it; their sub-queries run on the query's connection. */
export function planRow(query: { readonly Driver: OrmDriver }, entry: ResourceEntry): PlanRow {
  const driver = query.Driver;
  const relation = (name: 'owner' | 'self'): { column: string; typeColumn?: string } | undefined => {
    if (name === 'owner' && entry.owner) return Object.freeze({ column: entry.owner.column, ...(entry.owner.typeColumn !== undefined ? { typeColumn: entry.owner.typeColumn } : {}) });
    if (name === 'self' && entry.self) return Object.freeze({ column: entry.self.column });
    return undefined;
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
