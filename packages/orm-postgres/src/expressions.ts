import { SqlExpressions } from '@spinajs/orm';
import type { SqlFragment } from '@spinajs/orm';

export class PostgresSqlExpressions extends SqlExpressions {
  public castText(expression: string): string {
    return `CAST(${expression} AS TEXT)`;
  }

  // Read as a timestamp, node-postgres would place the wall-clock time in the process zone.
  public datetimeText(expression: string): string {
    return `CAST(${expression} AS TEXT)`;
  }

  public contains(haystack: SqlFragment, needle: SqlFragment): SqlFragment {
    return { sql: `strpos(${haystack.sql}, ${needle.sql}) > 0`, bindings: [...haystack.bindings, ...needle.bindings] };
  }

  // The default collations are deterministic.
  public equalsExactly(left: string, right: SqlFragment): SqlFragment {
    return { sql: `${left} = ${right.sql}`, bindings: [...right.bindings] };
  }
}
