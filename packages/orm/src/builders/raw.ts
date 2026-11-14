import { NewInstance } from '@spinajs/di';

@NewInstance()
export class RawQuery {
  get Query() {
    return this._query;
  }

  get Bindings() {
    return this._bindings;
  }

  public static create(query: string, bindings?: any[]) {
    return new RawQuery(query, bindings);
  }
  private _query = '';
  private _bindings: any[] = [];

  constructor(query: string, bindings?: any[]) {
    this._query = query;
    this._bindings = bindings ?? [];
  }
}
