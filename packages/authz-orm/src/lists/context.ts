import type { SqlRowContext } from '@spinajs/authz';
import type { QueryBuilder } from '@spinajs/orm';

import { AUTHZ_RESOURCE_ANCESTOR_TABLE } from '../ancestors/table.js';
import type { ResourceEntry } from '../registry.js';
import { castText, dialectOf, quoterOf } from './dialect.js';

/** What a PlanTermSql renders against: the builder's row, qualified by its alias or table. */
export function rowContext(query: QueryBuilder, entry: ResourceEntry, now: Date): SqlRowContext {
  const dialect = dialectOf(query.Driver);
  const q = quoterOf(query.Driver);
  const owner = q(query.TableAlias || query.Table);
  const rowColumn = (column: string): string => `${owner}.${q(column)}`;
  const relation = (name: 'owner' | 'self'): { column: string; typeColumn?: string } | undefined => {
    if (name === 'owner' && entry.owner) return Object.freeze({ column: entry.owner.column, ...(entry.owner.typeColumn !== undefined ? { typeColumn: entry.owner.typeColumn } : {}) });
    if (name === 'self' && entry.self) return Object.freeze({ column: entry.self.column });
    return undefined;
  };
  return Object.freeze({ type: entry.type, rowId: castText(dialect, rowColumn(entry.idColumn)), rowColumn, ancestorTable: q(AUTHZ_RESOURCE_ANCESTOR_TABLE), now, dialect, relation });
}
