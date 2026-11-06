import { InvalidArgument } from '@spinajs/exceptions';
import { OrmException } from '../exceptions.js';
import { ISort } from '../interfaces.js';
import { IQueryStatement } from '../statements.js';

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
