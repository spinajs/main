import { SqlExpressions } from '@spinajs/orm';
import type { IntervalUnit, RowLockMode, SqlFragment } from '@spinajs/orm';

const MAKE_INTERVAL_ARGUMENTS: Record<IntervalUnit, string> = { second: 'secs', minute: 'mins', hour: 'hours', day: 'days' };

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

  // clock_timestamp(), not now(): now() is frozen at the start of the transaction
  public epochMillis(): string {
    return 'CAST(ROUND(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT)';
  }

  public concat(...parts: string[]): string {
    return parts.join(' || ');
  }

  public ago(amount: number, unit: IntervalUnit): string {
    const checked = this.checkedInterval(amount, unit);

    return `(CURRENT_TIMESTAMP - make_interval(${MAKE_INTERVAL_ARGUMENTS[checked.unit]} => ${checked.amount}))`;
  }

  public rowLock(mode: RowLockMode): string {
    return mode === 'update' ? 'FOR UPDATE' : 'FOR SHARE';
  }
}
