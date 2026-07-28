import { Autoinject, NewInstance } from '@spinajs/di';
import { IdentifierQuoter, InSetStatement, IQueryStatement, IQueryStatementResult, SET_DELIMITER } from '@spinajs/orm';
import { _columnWrap } from '@spinajs/orm-sql';

/**
 * Membership test against a delimited `@Set()` column, MSSQL dialect.
 *
 * `CHARINDEX` over the column padded with delimiters on both sides — a value is a
 * member exactly when `,value,` occurs inside `,col,`. MSSQL concatenates with `+`,
 * not `||`, which is one of the reasons there is no single portable spelling of this
 * query and every driver registers its own.
 *
 * `ISNULL` keeps a NULL column out of the result instead of propagating NULL.
 */
@NewInstance()
export class MsSqlInSetStatement extends InSetStatement {
  @Autoinject(IdentifierQuoter)
  public Quoter: IdentifierQuoter;

  public build(): IQueryStatementResult {
    const column = _columnWrap(this.Quoter, this._column, this._tableAlias);
    const bindings: string[] = [];

    const expressions = this.values().map((value) => {
      bindings.push(`${SET_DELIMITER}${value}${SET_DELIMITER}`);
      return `(CHARINDEX(?, '${SET_DELIMITER}' + ISNULL(${column}, '') + '${SET_DELIMITER}') > 0)`;
    });

    return {
      Bindings: bindings,
      Statements: [this.combine(expressions)],
    };
  }

  public clone(): IQueryStatement {
    const clone = new MsSqlInSetStatement(this._column, this._val, this._not, this._tableAlias!);
    // a hand-constructed clone never goes through the container, so the injected
    // quoter has to be carried over explicitly
    clone.Quoter = this.Quoter;

    return clone;
  }
}

/**
 * Bracket quoting — SQL Server's rule, escaping an embedded `]` by doubling it.
 *
 * This driver used to import the shared BACKTICK helper and emit `` `table` ``, which
 * SQL Server does not accept, in every statement its own compilers did not replace.
 * Quoting is a service now, so registering this is all it takes.
 */
@NewInstance()
export class BracketIdentifierQuoter extends IdentifierQuoter {
  public quote(name: string): string {
    return '[' + String(name).replace(/]/g, ']]') + ']';
  }
}
