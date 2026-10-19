import { NotSupported } from '@spinajs/exceptions';

import type { SqlFragment } from './interfaces.js';

/**
 * SQL that the dialects spell differently, for code that writes raw SQL. Resolve it from the
 * connection, `driver.Container.resolve(SqlExpressions)`; each driver registers its own. What a
 * driver does not implement throws `NotSupported`.
 *
 * Expressions given as strings are SQL without bindings, such as a quoted column.
 */
export class SqlExpressions {
  /** `expression` as text; `length` bounds the type where the dialect needs one. */
  public castText(_expression: string, _length?: number): string {
    throw this.unsupported('castText');
  }

  /** A datetime column as the wall-clock text it stores, `yyyy-MM-dd HH:mm:ss[.SSS]`, never shifted into a zone. */
  public datetimeText(_expression: string): string {
    throw this.unsupported('datetimeText');
  }

  /** True where `needle` occurs in `haystack`. */
  public contains(_haystack: SqlFragment, _needle: SqlFragment): SqlFragment {
    throw this.unsupported('contains');
  }

  /** `left = right` compared byte for byte, whatever collation the column has: no case, accent or trailing-space folding. */
  public equalsExactly(_left: string, _right: SqlFragment): SqlFragment {
    throw this.unsupported('equalsExactly');
  }

  protected unsupported(name: string): NotSupported {
    return new NotSupported(`SqlExpressions.${name} is not supported by this connection's driver`);
  }
}
