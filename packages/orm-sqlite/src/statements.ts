/* eslint-disable prettier/prettier */
import { Autoinject, NewInstance } from '@spinajs/di';
import { IdentifierQuoter, InSetStatement, IQueryStatement, IQueryStatementResult, JoinMethod, IJoinStatementOptions, SET_DELIMITER } from '@spinajs/orm';
import { SqlJoinStatement, _columnWrap } from '@spinajs/orm-sql';
import { NotSupported } from '@spinajs/exceptions';

@NewInstance()
export class SqlLiteJoinStatement extends SqlJoinStatement {
  constructor(protected _options: IJoinStatementOptions) {
    super(_options);

    if (_options.method === JoinMethod.RIGHT || _options.method === JoinMethod.RIGHT_OUTER) {
      throw new NotSupported(`join method ${_options.method} is not supported by sqlite driver`);
    }
  }
}

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
