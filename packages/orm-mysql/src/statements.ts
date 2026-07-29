import { Autoinject, NewInstance } from '@spinajs/di';
import { IdentifierQuoter, InSetStatement, IQueryStatement, IQueryStatementResult } from '@spinajs/orm';
import { _columnWrap } from '@spinajs/orm-sql';

/**
 * Membership test against a delimited `@Set()` column, MySQL dialect.
 *
 * `FIND_IN_SET` is exactly this operation, and it lived in `@spinajs/orm-sql` — the
 * package every driver inherits from — until it was found reaching SQLite, where the
 * function does not exist and every query using it failed. It belongs here, with the
 * dialect that has it.
 */
@NewInstance()
export class MySqlInSetStatement extends InSetStatement {
  @Autoinject(IdentifierQuoter)
  public Quoter: IdentifierQuoter;

  public build(): IQueryStatementResult {
    const column = _columnWrap(this.Quoter, this._column, this._tableAlias);
    const bindings: string[] = [];

    const expressions = this.values().map((value) => {
      bindings.push(value);
      return `(FIND_IN_SET(?, ${column}) > 0)`;
    });

    return {
      Bindings: bindings,
      Statements: [this.combine(expressions)],
    };
  }

  public clone(): IQueryStatement {
    const clone = new MySqlInSetStatement(this._column, this._val, this._not, this._tableAlias!);
    // a hand-constructed clone never goes through the container, so the injected
    // quoter has to be carried over explicitly
    clone.Quoter = this.Quoter;

    return clone;
  }
}
