import { SqlExpressions } from '@spinajs/orm';
import type { SqlFragment } from '@spinajs/orm';

export class MsSqlSqlExpressions extends SqlExpressions {
  public castText(expression: string, length?: number): string {
    return `CAST(${expression} AS NVARCHAR(${length ?? 'MAX'}))`;
  }

  // Style 121 is `yyyy-mm-dd hh:mi:ss.mmm`; tedious would read the column as a UTC instant.
  public datetimeText(expression: string): string {
    return `CONVERT(varchar(23), ${expression}, 121)`;
  }

  public contains(haystack: SqlFragment, needle: SqlFragment): SqlFragment {
    return { sql: `CHARINDEX(${needle.sql}, ${haystack.sql}) > 0`, bindings: [...needle.bindings, ...haystack.bindings] };
  }

  // BIN2 stops case and accent folding; `=` still pads trailing spaces, which the LEN of the value with a suffix catches.
  public equalsExactly(left: string, right: SqlFragment): SqlFragment {
    return { sql: `(${left} = ${right.sql} COLLATE Latin1_General_BIN2 AND LEN(${left} + 'x') = LEN(${right.sql} + 'x'))`, bindings: [...right.bindings, ...right.bindings] };
  }
}
