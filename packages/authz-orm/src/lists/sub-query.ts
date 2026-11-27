import { AuthzConfigError } from '@spinajs/authz';
import { Injectable } from '@spinajs/di';
import { QueryMiddleware, SelectQueryBuilder } from '@spinajs/orm';
import type { IQueryStatement, ISelectQueryBuilder, QueryBuilder } from '@spinajs/orm';

import { marksOf } from '../marker.js';
import type { AccessMarks } from '../marker.js';
import { nameOf } from '../registry.js';
import { isUpdateOrDelete } from '../sync-statement.js';

type SelectParts = Pick<ISelectQueryBuilder, 'Statements' | 'JoinStatements' | 'getColumns' | 'Relations'>;

/** The mark that would change what the sub-query returns; `.unscoped()` only asks for less filtering, so it may be dropped. */
function appliedMark(marks: AccessMarks | undefined): string | undefined {
  if (marks === undefined) return undefined;
  if (marks.accessible !== undefined) return `.accessible(${JSON.stringify(marks.accessible)})`;
  if (marks.within !== undefined) return '.within()';
  if (marks.withAccess !== undefined) return '.withAccess()';
  if (marks.withFields !== undefined) return `.withFields(${JSON.stringify(marks.withFields)})`;
  return undefined;
}

/** Where a select holds sub-queries: conditions, joins, columns, and the to-one populates not folded into it yet. */
function partsOf(select: SelectParts): IQueryStatement[] {
  const pending = select.Relations.flatMap((relation) => {
    const waiting = relation.pendingQuery?.();
    return waiting === undefined ? [] : partsOf(waiting);
  });
  return [...select.Statements, ...select.JoinStatements, ...select.getColumns(), ...pending];
}

function refuseMarked(statements: readonly IQueryStatement[]): void {
  for (const statement of statements) {
    const sub = statement.SubQuery;
    if (sub !== undefined) {
      const mark = appliedMark(marksOf(sub));
      if (mark !== undefined) {
        const model = nameOf(sub.Model);
        throw new AuthzConfigError(
          `authz-orm: ${mark} on a sub-query of ${model} is not applied on this version: only a query that executes is filtered, and a sub-query is compiled into the statement around it. Execute the marked query on its own instead, for example load the ids of the ${model} rows the caller may read with an executed ${model}.query().select(<key>)${mark}, and pass them to whereIn() as values`,
        );
      }
      refuseMarked(partsOf(sub));
    }
    const nested = statement.nested?.();
    if (nested !== undefined) refuseMarked(nested);
  }
}

/**
 * Until a sub-query runs its own query middlewares, its access marks would be dropped silently and the statement
 * would read rows the caller may not see; the statement is refused instead. Order 90: before the write capture's key
 * read (91) copies the conditions into SQL of its own, and before the access list (100) plans the statement.
 */
@Injectable(QueryMiddleware)
export class SubQueryMarksMiddleware extends QueryMiddleware {
  public order = 90;

  afterQueryCreation(_query: QueryBuilder): void {}

  beforeQueryExecution(query: QueryBuilder): void {
    if (query instanceof SelectQueryBuilder) refuseMarked(partsOf(query));
    else if (isUpdateOrDelete(query)) refuseMarked(query.Statements);
  }
}
