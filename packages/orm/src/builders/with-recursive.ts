import { NewInstance } from '@spinajs/di';
import type { Container } from '@spinajs/di';
import type { IWithRecursiveBuilder } from '../interfaces.js';
import { WithRecursiveStatement } from '../statements.js';
import type { IQueryStatement } from '../statements.js';

@NewInstance()
export class WithRecursiveBuilder implements IWithRecursiveBuilder {
  protected _container!: Container;

  protected _cteStatement: IQueryStatement | undefined;

  public get CteRecursive() {
    return this._cteStatement;
  }

  public withRecursive(rcKeyName: string, pkName: string) {
    this._cteStatement = this._container.resolve<WithRecursiveStatement>(WithRecursiveStatement, ['cte', this, rcKeyName, pkName]);
    return this;
  }

  /**
   * Drops the recursive CTE from this builder.
   *
   * `WithRecursiveStatement.build()` compiles two CLONES of the owning query — the anchor
   * member and the recursive member of the CTE. `clone()` copies `_cteStatement`, so each
   * clone was still marked recursive and compiling it re-entered `build()`, which cloned
   * again: an unbounded mutual recursion between `toDB()` and the recursive compiler that
   * ended in a stack overflow rather than a query. The two member queries are by definition
   * not themselves recursive, so the statement clears the flag on its clones.
   *
   * Named alongside `clearJoins()` / `clearWhere()`, which `build()` already uses to strip the
   * parts of the parent query each member must not inherit.
   */
  public clearRecursive() {
    this._cteStatement = undefined;
    return this;
  }
}
