import { SqlExpressions } from '@spinajs/orm';
import type { SqlFragment } from '@spinajs/orm';

export class MySqlSqlExpressions extends SqlExpressions {
  public castText(expression: string, length?: number): string {
    return `CAST(${expression} AS CHAR${length === undefined ? '' : `(${length})`})`;
  }

  public datetimeText(expression: string): string {
    return `CAST(${expression} AS CHAR)`;
  }

  public contains(haystack: SqlFragment, needle: SqlFragment): SqlFragment {
    return { sql: `LOCATE(${needle.sql}, ${haystack.sql}) > 0`, bindings: [...needle.bindings, ...haystack.bindings] };
  }

  // Against a binary string the comparison ignores the column collation (utf8mb4_0900_ai_ci folds case and accents).
  public equalsExactly(left: string, right: SqlFragment): SqlFragment {
    return { sql: `${left} = CAST(${right.sql} AS BINARY)`, bindings: [...right.bindings] };
  }
}
