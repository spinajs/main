import { SqlExpressions } from '@spinajs/orm';
import type { IntervalUnit, RowLockMode, SqlFragment } from '@spinajs/orm';

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

  // Binary strings ignore the column collation (utf8mb4_0900_ai_ci folds case and accents, utf8mb4_bin trailing spaces).
  // `left` is cast too: beside a plain `left = ?` MySQL 8.4 propagates that constant into a bare `left` and folds again.
  public equalsExactly(left: string, right: SqlFragment): SqlFragment {
    return { sql: `CAST(${left} AS BINARY) = CAST(${right.sql} AS BINARY)`, bindings: [...right.bindings] };
  }

  // UTC_TIMESTAMP, not UNIX_TIMESTAMP(NOW()): mapping a session-local time back to epoch is off by an hour inside a repeated DST hour
  public epochMillis(): string {
    return "TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(3)) DIV 1000";
  }

  public concat(...parts: string[]): string {
    return parts.length === 1 ? parts[0] : `CONCAT(${parts.join(', ')})`;
  }

  // UTC_TIMESTAMP, as MySqlNowExpression: a `TimeZone: 'UTC'` connection writes datetimes in UTC
  public ago(amount: number, unit: IntervalUnit): string {
    const checked = this.checkedInterval(amount, unit);

    return `(UTC_TIMESTAMP(3) - INTERVAL ${checked.amount} ${checked.unit.toUpperCase()})`;
  }

  // LOCK IN SHARE MODE, not FOR SHARE: MariaDB and MySQL 5.7 only know the former
  public rowLock(mode: RowLockMode): string {
    return mode === 'update' ? 'FOR UPDATE' : 'LOCK IN SHARE MODE';
  }
}

/** The expressions of a connection not pinned to UTC: `ago()` counts back from the session wall clock, as `now()` does. */
export class MySqlSessionSqlExpressions extends MySqlSqlExpressions {
  public ago(amount: number, unit: IntervalUnit): string {
    const checked = this.checkedInterval(amount, unit);

    return `(NOW(3) - INTERVAL ${checked.amount} ${checked.unit.toUpperCase()})`;
  }
}
