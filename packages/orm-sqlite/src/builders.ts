import { NewInstance } from '@spinajs/di';
import { DefaultValueBuilder, RawQuery } from '@spinajs/orm';

@NewInstance()
export class SqlLiteDefaultValueBuilder<T> extends DefaultValueBuilder<T> {
  constructor(protected Owner: T) {
    super();
  }

  public date(): T {
    this.Query = RawQuery.create("(strftime('%Y-%m-%d', 'now'))");
    return this.Owner;
  }

  public dateTime(): T {
    this.Query = RawQuery.create("strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
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
