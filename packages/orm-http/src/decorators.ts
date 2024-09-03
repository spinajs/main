import { IModelDescriptor, ModelBase, extractDecoratorDescriptor } from '@spinajs/orm';
import { FilterableOperators } from './interfaces.js';
import {  Constructor } from '@spinajs/di';
import { Parameter, Route } from '@spinajs/http';

export function Filterable(operators: FilterableOperators[]) {
  return extractDecoratorDescriptor((model: IModelDescriptor, _target: any, propertyKey: string) => {
    const columnDesc = model.Columns.find((c) => c.Name === propertyKey);
    if (!columnDesc) {
      // we dont want to fill all props, they will be loaded from db and mergeg with this
      model.Columns.push({ Name: propertyKey, Filterable: operators } as any);
    } else {
      columnDesc.Filterable = operators;
    }
  }, true);
}

export type CustomFilterSchema  = { Field : string, Operators : FilterableOperators[]};

export function Filter(model: Constructor<ModelBase> | CustomFilterSchema[]) {
  return Route(Parameter("FilterModelRouteArg",null, model));
}
