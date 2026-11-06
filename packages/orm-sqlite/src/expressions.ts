import { SqlExpressions } from '@spinajs/orm';
import type { IntervalUnit, SqlFragment } from '@spinajs/orm';

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

  public epochMillis(): string {
    return "CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)";
  }

  public concat(...parts: string[]): string {
    return parts.join(' || ');
  }

  // the text SqliteNowExpression and the ISO datetime converter write, so the columns compare as text
  public ago(amount: number, unit: IntervalUnit): string {
    return `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${amount} ${unit}s')`;
  }

  public rowLock(): string {
    return '';
  }
}
