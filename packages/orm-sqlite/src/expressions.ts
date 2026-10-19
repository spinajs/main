import { SqlExpressions } from '@spinajs/orm';
import type { SqlFragment } from '@spinajs/orm';

export class SqliteSqlExpressions extends SqlExpressions {
  public castText(expression: string): string {
    return `CAST(${expression} AS TEXT)`;
  }

  // Datetimes are stored as text already.
  public datetimeText(expression: string): string {
    return expression;
  }

  public contains(haystack: SqlFragment, needle: SqlFragment): SqlFragment {
    return { sql: `instr(${haystack.sql}, ${needle.sql}) > 0`, bindings: [...haystack.bindings, ...needle.bindings] };
  }

  // BINARY is the default collation.
  public equalsExactly(left: string, right: SqlFragment): SqlFragment {
    return { sql: `${left} = ${right.sql}`, bindings: [...right.bindings] };
  }
}
