import { WhereStatement } from '@spinajs/orm';
import type { IQueryStatement, IWhereBuilder } from '@spinajs/orm';

type Where = IWhereBuilder<unknown>;

const isHaving = (statement: IQueryStatement): boolean => statement instanceof WhereStatement && statement.IsAggregate;

/**
 * `(what the caller wrote) AND column = tenant`. The ORM joins where statements without grouping them, so the
 * caller's statements move into one group first and an orWhere cannot leave it; HAVING statements stay where they are.
 */
export function confine(query: Where, column: string, tenant: string): void {
  const statements = query.Statements;
  const callers = statements.filter((statement) => !isHaving(statement));
  const having = statements.filter(isHaving);
  statements.length = 0;
  if (callers.length > 0) {
    query.where(function () {
      this.Statements.push(...callers);
    });
  }
  query.where(column, tenant);
  statements.push(...having);
}
