import { PlanTermSql } from '@spinajs/authz';
import type { SqlFragment, SqlRowContext } from '@spinajs/authz';

/** A test op: the row's `flag` column equals `args.flag`. */
export class FlagSql extends PlanTermSql {
  readonly op = 'test.flag';
  toSql(args: unknown, row: SqlRowContext): SqlFragment {
    return { sql: `${row.rowColumn('flag')} = ?`, bindings: [(args as { flag: string }).flag] };
  }
}

/** A compiler that breaks its contract. */
export class BrokenSql extends PlanTermSql {
  readonly op = 'test.broken';
  toSql(): SqlFragment {
    return { sql: 1 } as unknown as SqlFragment;
  }
}
