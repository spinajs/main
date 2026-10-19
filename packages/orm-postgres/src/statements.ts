import { Container, IContainer, Inject, NewInstance } from '@spinajs/di';
import { IdentifierQuoter, OrmDriver } from '@spinajs/orm';
import { SqlDateTimeWrapper, SqlJoinStatement, SqlLiteralQuoter } from '@spinajs/orm-sql';
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

/**
 * A connection cannot reach another database, so the shared `"<database>"."<table>"`
 * spelling would be read as a schema named like the database. Joined tables are
 * qualified with the configured schema instead, or left bare to follow search_path.
 */
@NewInstance()
export class PostgresJoinStatement extends SqlJoinStatement {
  protected tableQualifier(driver: OrmDriver): string | undefined {
    return driver.Options.Options?.Schema as string | undefined;
  }
}

/** PostgreSQL has no `DATETIME()` function; a cast to TIMESTAMP is its spelling. */
@NewInstance()
export class PostgresDateTimeWrapper extends SqlDateTimeWrapper {
  public wrap(): string {
    const column = this._tableAlias ? `${this.Quoter.quote(this._tableAlias)}.${this.Quoter.quote(this._value as string)}` : this.Quoter.quote(this._value as string);
    return `CAST(${column} AS TIMESTAMP)`;
  }
}
