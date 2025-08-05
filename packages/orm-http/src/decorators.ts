import { IModelDescriptor, ModelBase, WhereFunction, _prepareColumnDesc, extractDecoratorPropertyDescriptor, extractModelDescriptor } from '@spinajs/orm';
import { FilterableOperators, IColumnFilter } from './interfaces.js';
import { Constructor, isConstructor } from '@spinajs/di';
import { Parameter, Route } from '@spinajs/http';

export function Filterable(operatorsOrClass: FilterableOperators[] | Constructor<ModelBase>, queryFunc?: (operator: FilterableOperators, value: any) => WhereFunction<unknown>, isAggregate?: boolean) {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, _target: any, propertyKey: string) => {
    if (model.FilterableColumns === undefined) {
      model.FilterableColumns = new Map<string, IColumnFilter<unknown>>();
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

        model.FilterableColumns = new Map<string, IColumnFilter<unknown>>([...model.FilterableColumns.entries(), ...(ops as any)]);
      }
    } else {
      if (!operatorsOrClass) {
        throw new Error(`Filterable decorator on ${model.Name} model, property ${propertyKey} must have operators defined`);
      }
      model.FilterableColumns.set(propertyKey, {
        operators: operatorsOrClass,
        query: queryFunc,
      } as IColumnFilter<unknown>);
    }

    const columnDesc = model.Columns.find((c) => c.Name === propertyKey);
    if (!columnDesc) {
      // we dont want to fill all props, they will be loaded from db and mergeg with this
      model.Columns.push(_prepareColumnDesc({ Name: propertyKey, Aggregate: isAggregate ?? false, Virtual: true }));
    } else {
      columnDesc.Aggregate = isAggregate ?? false;
    }
  });
}

export function Filter(model: Constructor<ModelBase> | IColumnFilter<unknown>[]) {
  return Route(Parameter('FilterModelRouteArg', null, model));
}
