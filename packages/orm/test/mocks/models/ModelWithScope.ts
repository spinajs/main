/* eslint-disable prettier/prettier */
import { ISelectQueryBuilder, QueryScope } from '../../../src/interfaces.js';
import { Connection, Primary, Model } from '../../../src/decorators.js';
import { ModelBase } from '../../../src/model.js';

export class ModelWithScopeQueryScope implements QueryScope {
  whereIdIsGreaterThan(this: ISelectQueryBuilder<Array<ModelWithScope>> & ModelWithScopeQueryScope, val: number): ISelectQueryBuilder<Array<ModelWithScope>> & ModelWithScopeQueryScope {
    this.where('Id', '>=', val);
    return this;
  }

  /**
   * Builder-agnostic scope: `this` is typed structurally, so the same method binds to select,
   * update and delete builders alike. Scopes meant to be reusable across statement types must
   * be written this way.
   */
  whereBarEquals<This extends ModelWithScopeQueryScope>(this: This, val: string): This {
    (this as any).where('Bar', val);
    return this;
  }
}

@Connection('sqlite')
@Model('TestTable1')
export class ModelWithScope extends ModelBase {
  public static readonly _queryScopes: ModelWithScopeQueryScope = new ModelWithScopeQueryScope();

  @Primary()
  public Id: number;

  public Bar: string;
}
