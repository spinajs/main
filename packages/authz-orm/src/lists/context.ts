import type { SqlRowContext } from '@spinajs/authz';
import { SqlExpressions } from '@spinajs/orm';
import type { QueryBuilder } from '@spinajs/orm';

import { AUTHZ_RESOURCE_ANCESTOR_TABLE } from '../ancestors/table.js';
import { namedRelation } from '../registry.js';
import type { ResourceEntry } from '../registry.js';
import { quoterOf } from './quoter.js';

/** authz_resource_ancestor.resource_id holds 64 characters. */
export const ROW_ID_LENGTH = 64;

/** What a PlanTermSql renders against: the builder's row, qualified by its alias or table. */
export function rowContext(query: QueryBuilder, entry: ResourceEntry, now: Date): SqlRowContext {
  const expressions = query.Driver.Container.resolve(SqlExpressions);
  const q = quoterOf(query.Driver);
  const owner = q(query.TableAlias || query.Table);
  const rowColumn = (column: string): string => `${owner}.${q(column)}`;
  const relation = (name: string): { column: string; typeColumn?: string } | undefined => {
    const columns: { column: string; typeColumn?: string } | undefined = name === 'owner' ? entry.owner : name === 'self' ? entry.self : namedRelation(entry, name);
    if (!columns) return undefined;
    return Object.freeze({ column: columns.column, ...(columns.typeColumn !== undefined ? { typeColumn: columns.typeColumn } : {}) });
  };
  return Object.freeze({ type: entry.type, rowId: expressions.castText(rowColumn(entry.idColumn), ROW_ID_LENGTH), rowColumn, ancestorTable: q(AUTHZ_RESOURCE_ANCESTOR_TABLE), now, expressions, relation });
}
