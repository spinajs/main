/* eslint-disable prettier/prettier */
import { IWhereBuilder, QueryScope } from '@spinajs/orm';
import { Connection, Primary, Model } from '../../../src/decorators';
import { ModelBase } from '../../../src/model';

export class ModelWithScopeQueryScope implements QueryScope {
  whereIdIsGreaterThan(this: IWhereBuilder<ModelWithScope>, val: number) {
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
