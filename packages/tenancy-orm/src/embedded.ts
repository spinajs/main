import { DeleteQueryBuilder, SelectQueryBuilder, UpdateQueryBuilder } from '@spinajs/orm';
import type { IQueryStatement, ISelectQueryBuilder, QueryBuilder } from '@spinajs/orm';

type SelectParts = Pick<ISelectQueryBuilder, 'Statements' | 'JoinStatements' | 'getColumns' | 'Relations'>;

/** Where a select holds sub-queries: conditions, joins, columns, and the to-one populates not folded into it yet. */
function partsOf(select: SelectParts): IQueryStatement[] {
  const pending = select.Relations.flatMap((relation) => {
    const waiting = relation.pendingQuery?.();
    return waiting === undefined ? [] : partsOf(waiting);
  });
  return [...select.Statements, ...select.JoinStatements, ...select.getColumns(), ...pending];
}

function selectsIn(statements: readonly IQueryStatement[], found: SelectQueryBuilder[]): SelectQueryBuilder[] {
  for (const statement of statements) {
    if (statement.SubQuery !== undefined) found.push(statement.SubQuery);
    const nested = statement.nested?.();
    if (nested !== undefined) selectsIn(nested, found);
  }
  return found;
}

/** The selects compiled into `query` one level down; the selects inside those are theirs. */
export function embeddedSelects(query: QueryBuilder): SelectQueryBuilder[] {
  if (query instanceof SelectQueryBuilder) return selectsIn(partsOf(query), []);
  if (query instanceof UpdateQueryBuilder || query instanceof DeleteQueryBuilder) return selectsIn(query.Statements, []);
  return [];
}
