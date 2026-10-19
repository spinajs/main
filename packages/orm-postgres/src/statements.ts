import { Container, IContainer, Inject, NewInstance } from '@spinajs/di';
import { IdentifierQuoter, NowExpression } from '@spinajs/orm';
import { SqlInStatement, SqlLiteralQuoter } from '@spinajs/orm-sql';
import pg from 'pg';

/**
 * PostgreSQL quotes identifiers with the ANSI double quote and escapes an embedded `"` by
 * doubling it. The shared `orm-sql` helper emits backticks, which PostgreSQL reads as an
 * operator error, so the driver carries its own escaper for its internal SQL ( savepoint
 * names, schema probes ) the same way MSSQL does.
 */
export function pgEscapeIdentifier(name: string): string {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/**
 * The ANSI double quote — PostgreSQL's identifier quoting. Registered by the postgres
 * driver as its {@link IdentifierQuoter}, never inherited: MySQL rejects `"` as an
 * identifier quote unless ANSI_QUOTES is on, so nothing here is portable either way.
 */
@NewInstance()
export class DoubleQuoteIdentifierQuoter extends IdentifierQuoter {
  public quote(name: string): string {
    return pgEscapeIdentifier(name);
  }
}

@NewInstance()
@Inject(Container)
export class PostgresLiteralQuoter extends SqlLiteralQuoter {
  constructor(container: IContainer) {
    super(container);
  }

  protected quoteString(value: string): string {
    return pg.escapeLiteral(value);
  }

  protected quoteBoolean(value: boolean): string {
    return value ? 'TRUE' : 'FALSE';
  }
}

/** A long list is bound as one array parameter; postgres infers the element type from the column. */
@NewInstance()
export class PostgresInStatement extends SqlInStatement {
  protected listExpression(column: string): string {
    return this._not ? `${column} <> ALL(?)` : `${column} = ANY(?)`;
  }

  protected listBinding(values: unknown[]): unknown {
    return values;
  }
}

/** The start of the current transaction, as for a column default. */
export class PostgresNowExpression extends NowExpression {
  public sql(): string {
    return 'CURRENT_TIMESTAMP';
  }
}
