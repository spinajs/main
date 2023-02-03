/* eslint-disable prettier/prettier */
import { ISelectQueryBuilder, QueryScope } from '../../../src/interfaces.js';
import { Connection, Primary, Model } from '../../../src/decorators.js';
import { ModelBase } from '../../../src/model.js';

export class ModelWithScopeQueryScope implements QueryScope {
  whereIdIsGreaterThan(this: ISelectQueryBuilder<ModelWithScope> & ModelWithScopeQueryScope, val: number): ISelectQueryBuilder<ModelWithScope> & ModelWithScopeQueryScope {
    this.where('Id', '>=', val);
    return this;
  }
}

@Connection('sqlite')
@Model('TestTable1')
export class ModelWithScope extends ModelBase {
  public static readonly _queryScopes: ModelWithScopeQueryScope = new ModelWithScopeQueryScope();

  @Primary()
  public Id: number;
}
