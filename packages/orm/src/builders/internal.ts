import { InvalidArgument } from '@spinajs/exceptions';
import { OrmException } from '../exceptions.js';
import { QueryMethod } from '../enums.js';
import type { ISelectQueryBuilder, ISort } from '../interfaces.js';
import type { IQueryStatement } from '../statements.js';
import { QueryBuilder } from './base.js';

/**
 * A `Relation.column` sort is compiled on the relation query, so the owner keeps an empty-column
 * slot (`awaits`) where it was requested; the relation's sort answers it (`fills`) when merged.
 */
export interface IRelationSort extends ISort {
  awaits?: symbol;
  fills?: symbol;
}

// Checked before the query middlewares run: one that adds its own WHERE (an ownership filter)
// would otherwise pass a statement the caller never narrowed.
export function assertNarrowed(statement: string, table: string, statements: IQueryStatement[], floor?: number) {
  if (floor !== undefined && statements.length <= floor) {
    throw new OrmException(`Refusing an unbounded ${statement} on ${table}; narrow it with where(), or use truncate() to clear the table`);
  }
}

// These reach the SQL text unquoted, so a value outside the list is refused, not interpolated.
export function assertOneOf<T extends string>(value: T, allowed: readonly string[], clause: string): T {
  if (!allowed.includes(value)) {
    throw new InvalidArgument(`invalid ${clause} "${value}", expected one of: ${allowed.join(', ')}`);
  }

  return value;
}

// where.ts tells a select sub-query from a value list with this: importing builders/select.ts
// there would close a cycle, select.ts passes WhereBuilder to @use().
export function isSelectQuery(value: unknown): value is ISelectQueryBuilder {
  return value instanceof QueryBuilder && (value as unknown as { _method: QueryMethod })._method === QueryMethod.SELECT;
}

type CloneHook = (source: QueryBuilder, clone: QueryBuilder) => void;

// Set by Orm.resolve() from the registered query extensions; select.ts reads them here because
// importing extension-install.ts would close a cycle (it imports select.ts).
let cloneHooks: readonly CloneHook[] = [];

export function setCloneHooks(hooks: readonly CloneHook[]): void {
  cloneHooks = hooks;
}

export function runCloneHooks(source: QueryBuilder, clone: QueryBuilder): void {
  for (const hook of cloneHooks) hook(source, clone);
}

export const EXECUTION_LISTS = ['_statements', '_joinStatements', '_columns', '_groupStatements', '_sorts', '_relations', '_middlewares', '_queryMiddlewares'] as const;

/**
 * A copy of `query` for one more execution (a builder runs once): it owns the lists that the caller, a query
 * middleware or the execution appends to, and shares the statements instead of cloning them as `clone()` does.
 * `setAlias()` on a copy writes through to the statements it shares with the original.
 */
export function executionCopy<Q extends object>(query: Q): Q {
  const source = query as unknown as Record<string, unknown>;
  const copy = Object.create(query) as Record<string, unknown>;
  for (const key of EXECUTION_LISTS) {
    copy[key] = [...(source[key] as unknown[])];
  }
  copy._limit = { ...(source._limit as object) };
  // the CTE compiles its owning query, which has to be the copy for the copy's WHERE to reach it
  copy._cteStatement = (source._cteStatement as IQueryStatement | undefined)?.clone(copy as unknown as QueryBuilder);
  copy._executionPromise = null;

  return copy as Q;
}
