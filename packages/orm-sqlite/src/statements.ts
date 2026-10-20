/* eslint-disable prettier/prettier */
import { Autoinject, NewInstance } from '@spinajs/di';
import { IdentifierQuoter, InSetStatement, StartsWithStatement, IQueryStatement, IQueryStatementResult, NowExpression, SET_DELIMITER } from '@spinajs/orm';
import { SqlInStatement, SqlJoinStatement, _columnWrap } from '@spinajs/orm-sql';

/**
 * Adds nothing to the shared statement: the bundled SQLite ( 3.39 and later ) runs RIGHT JOIN too.
 * Kept as the sqlite join token so subclasses have a dialect-specific base.
 */
@NewInstance()
export class SqlLiteJoinStatement extends SqlJoinStatement {}

/**
 * Membership test against a delimited `@Set()` column, SQLite dialect.
 *
 * `instr` over the column padded with delimiters on both sides: a value is a member
 * exactly when `,value,` occurs inside `,col,`. One binding per value and no LIKE
 * escaping to get wrong, which is why this is preferred over the portable form
 * inherited from `@spinajs/orm-sql`.
 *
 * `IFNULL` keeps a NULL column out of the result rather than propagating NULL
 * through `instr` — a row with no roles is not a member of any set.
 */
@NewInstance()
export class SqliteInSetStatement extends InSetStatement {
  @Autoinject(IdentifierQuoter)
  public Quoter: IdentifierQuoter;

  public build(): IQueryStatementResult {
    const column = _columnWrap(this.Quoter, this._column, this._tableAlias);
    const bindings: string[] = [];

    const expressions = this.values().map((value) => {
      bindings.push(`${SET_DELIMITER}${value}${SET_DELIMITER}`);
      return `(instr('${SET_DELIMITER}' || IFNULL(${column}, '') || '${SET_DELIMITER}', ?) > 0)`;
    });

    return {
      Bindings: bindings,
      Statements: [this.combine(expressions)],
    };
  }

  public clone(): IQueryStatement {
    const clone = new SqliteInSetStatement(this._column, this._val, this._not, this._tableAlias!);
    // a hand-constructed clone never goes through the container, so the injected
    // quoter has to be carried over explicitly
    clone.Quoter = this.Quoter;

    return clone;
  }
}

/** A long list travels as one JSON array, so it never meets SQLITE_MAX_VARIABLE_NUMBER. */
@NewInstance()
export class SqliteInStatement extends SqlInStatement {
  protected listExpression(column: string): string {
    return `${column} ${this._not ? 'NOT IN' : 'IN'} (SELECT value FROM json_each(?))`;
  }
}

/** GLOB, not LIKE: SQLite's LIKE ignores ASCII case whatever the column's collation. */
@NewInstance()
export class SqliteStartsWithStatement extends StartsWithStatement {
  @Autoinject(IdentifierQuoter)
  public Quoter: IdentifierQuoter;

  public build(): IQueryStatementResult {
    return {
      Bindings: [`${this.prefix().replace(/[*?[]/g, (c) => `[${c}]`)}*`],
      Statements: [`${_columnWrap(this.Quoter, this._column, this._tableAlias)} GLOB ?`],
    };
  }

  public clone(): IQueryStatement {
    const clone = new SqliteStartsWithStatement(this._column, this._prefix, this._tableAlias!);
    clone.Quoter = this.Quoter;

    return clone;
  }
}

/** The text the datetime converter writes, so stored values compare with it as text. */
export class SqliteNowExpression extends NowExpression {
  public sql(): string {
    return "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
  }
}
