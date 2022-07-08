import { NewInstance } from '@spinajs/di';
import { DefaultValueBuilder, RawQuery } from '@spinajs/orm';

@NewInstance()
export class SqlDefaultValueBuilder<T> extends DefaultValueBuilder<T> {
  public Query: RawQuery;
  public Value: string | number;

  constructor(protected Owner: T) {
    super();
  }

  public date(): T {
    this.Query = RawQuery.create('(CURRENT_DATE())');
    return this.Owner;
  }

  public dateTime(): T {
    this.Query = RawQuery.create('CURENT_TIMESTAMP');
    return this.Owner;
  }

  public value(val: string | number): T {
    this.Value = val;
    return this.Owner;
  }

  public raw(query: RawQuery): T {
    this.Query = query;
    return this.Owner;
  }
}
