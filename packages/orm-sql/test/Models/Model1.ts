import { Connection, ModelBase, Model, Primary, QueryScope, IWhereBuilder } from '@spinajs/orm';

export class Model1QueryScope implements QueryScope {
  whereIdIsGreaterThan(this: IWhereBuilder<Model1>, val: number) {
    this.where('Id', '>=', val);
    return this;
  }
}

@Connection('sqlite')
@Model('TestTable1')
export class Model1 extends ModelBase {
  public static readonly _queryScopes: Model1QueryScope = new Model1QueryScope();

  @Primary()
  public Id: number;

  public Bar: string;
}
