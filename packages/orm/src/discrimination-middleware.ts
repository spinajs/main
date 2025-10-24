/* eslint-disable prettier/prettier */
import { IModelDescriptor, IBuilderMiddleware } from './interfaces.js';
import { ModelBase } from './model.js';

export class DiscriminationMapMiddleware implements IBuilderMiddleware {
  constructor(protected _description: IModelDescriptor) {}

  public afterQuery(data: any[]): any[] {
    return data;
  }

  public modelCreation(data: any): ModelBase {
    if (this._description.DiscriminationMap && this._description.DiscriminationMap.Field) {
      const distValue = data[this._description.DiscriminationMap.Field];
      if (distValue && this._description.DiscriminationMap.Models.has(distValue)) {
        const result = new (this._description.DiscriminationMap.Models.get(distValue) as any)();
        result.hydrate(data);

        return result;
      }
    }

    return null;
  }

  // tslint:disable-next-line: no-empty
  public async afterHydration(_data: ModelBase[]) {}
}
