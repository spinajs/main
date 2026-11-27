import { LazyQueryStatement, SqlOperator, WhereBoolean, WhereBuilder, WhereQueryStatement, WhereStatement } from '@spinajs/orm';
import type { IQueryStatement, IWhereBuilder } from '@spinajs/orm';

type Where = IWhereBuilder<unknown>;

const isHaving = (statement: IQueryStatement): boolean => statement instanceof WhereStatement && statement.IsAggregate;

/**
 * The shape confine() leaves, read from the statements themselves: one builder can be confined twice, as a sub-query
 * that also runs on its own, one used twice in a statement, or a clone of a confined one.
 */
function isConfined(query: Where, column: string, tenant: string): boolean {
  const conditions = query.Statements.filter((statement) => !isHaving(statement));
  const last = conditions.at(-1);
  const callers = conditions.slice(0, -1);
  const byTenant = last instanceof WhereStatement && last.Column === column && last.Operator === SqlOperator.EQ && last.Value === tenant && last.Boolean === WhereBoolean.AND && last.OnJoin !== true;
  return byTenant && callers.length <= 1 && callers.every((statement) => WhereQueryStatement.isGroup(statement));
}

/**
 * `(what the caller wrote) AND column = tenant`. The ORM joins where statements without grouping them, so the
 * caller's statements move into one group first and an orWhere cannot leave it; HAVING statements stay where they are.
 */
export function confine(query: Where, column: string, tenant: string): void {
  if (isConfined(query, column, tenant)) return;
  const statements = query.Statements;
  const callers = statements.filter((statement) => !isHaving(statement));
  const having = statements.filter(isHaving);
  statements.length = 0;
  if (callers.length > 0) {
    query.where(function () {
      for (const statement of callers) {
        // Adopted, not rebound: a clone of the group would bind a Lazy to the group's builder, which it cannot
        // compile against. Every relation sub-query correlates through one.
        if (statement instanceof LazyQueryStatement && this instanceof WhereBuilder) this.adopt([statement]);
        else this.Statements.push(statement);
      }
    });
  }
  query.where(column, tenant);
  statements.push(...having);
}
