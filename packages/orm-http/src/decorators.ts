import { IModelDescriptor, ModelBase, _prepareColumnDesc, extractDecoratorPropertyDescriptor, extractModelDescriptor } from '@spinajs/orm';
import { FilterableOperators } from './interfaces.js';
import { Constructor, isConstructor } from '@spinajs/di';
import { Parameter, Route } from '@spinajs/http';

export function Filterable(operatorsOrClass: FilterableOperators[] | Constructor<ModelBase> , isAggregate? : boolean) {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, _target: any, propertyKey: string) => {
    if (model.FilterableColumns === undefined) {
      model.FilterableColumns = new Map<string, FilterableOperators[]>();
    }

    if (isConstructor(operatorsOrClass)) {
      // if we have @belonsgTo relation we add to this filter schema all avaible filters
      // from the related model
      const descriptor = extractModelDescriptor(operatorsOrClass);
      if (descriptor.FilterableColumns) {
        const keys = [...descriptor.FilterableColumns.keys()];
        const ops = keys.map((k) => {
          return [`${propertyKey}.${k}`, descriptor.FilterableColumns.get(k)];
        });

        model.FilterableColumns = new Map<string, FilterableOperators[]>([...model.FilterableColumns.entries(), ...ops as any]);
      }
    } else {
      if (!operatorsOrClass) {
        throw new Error(`Filterable decorator on ${model.Name} model, property ${propertyKey} must have operators defined`);
      }
      model.FilterableColumns.set(propertyKey, operatorsOrClass);
    }

    const columnDesc = model.Columns.find((c) => c.Name === propertyKey);
    if (!columnDesc) {
      // we dont want to fill all props, they will be loaded from db and mergeg with this
      model.Columns.push(_prepareColumnDesc({ Name: propertyKey, Aggregate: isAggregate ?? false }));
    } else {
      columnDesc.Aggregate = isAggregate ?? false;
    }
  });
}

export type CustomFilterSchema = { Column: string; Operators: FilterableOperators[] };

export function Filter(model: Constructor<ModelBase> | CustomFilterSchema[]) {
  return Route(Parameter('FilterModelRouteArg', null, model));
}
