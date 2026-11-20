import { SelectQueryBuilder } from '../src/builders.js';
import type { QueryBuilder, WhereBuilder } from '../src/builders.js';
import { ColumnStatement, JoinStatement } from '../src/statements.js';
import type { IQueryStatementResult } from '../src/statements.js';

export class FakeColumnStatement extends ColumnStatement {
  public build(): IQueryStatementResult {
    return { Statements: [], Bindings: [] };
  }

  public clone(): FakeColumnStatement {
    return new FakeColumnStatement(this._column, this._alias, this.TableAlias, this._descriptor);
  }
}

export class FakeJoinStatement extends JoinStatement {
  public build(): IQueryStatementResult {
    return { Statements: [], Bindings: [] };
  }

  public clone(parent?: QueryBuilder | WhereBuilder<unknown>): FakeJoinStatement {
    const copy = new FakeJoinStatement({
      ...this._options,
      builder: parent instanceof SelectQueryBuilder ? parent : this._options.builder,
      callback: undefined,
      queryCallback: undefined,
    });
    if (this._whereBuilder !== undefined) {
      copy._whereBuilder = this._whereBuilder.clone();
    }
    return copy;
  }
}
