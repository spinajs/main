import { IModelDescriptor, ModelBase, WhereFunction, _prepareColumnDesc, extractDecoratorPropertyDescriptor, extractModelDescriptor } from '@spinajs/orm';
import { AggregateFunction, FilterableOperators, IColumnFilter, IFilterableOptions } from './interfaces.js';
import { Constructor, isConstructor } from '@spinajs/di';
import { Parameter, Route } from '@spinajs/http';

export function Filterable(options: IFilterableOptions): ReturnType<typeof extractDecoratorPropertyDescriptor>;
// `queryFunc` accepts null so that a column can opt out of a custom query while still
// setting the trailing `isAggregate` flag.
export function Filterable(operatorsOrClass: FilterableOperators[] | Constructor<ModelBase>, queryFunc?: ((operator: FilterableOperators, value: any) => WhereFunction<unknown>) | null, isAggregate?: boolean): ReturnType<typeof extractDecoratorPropertyDescriptor>;
export function Filterable(operatorsOrClass: FilterableOperators[] | Constructor<ModelBase> | IFilterableOptions, queryFunc?: ((operator: FilterableOperators, value: any) => WhereFunction<unknown>) | null, isAggregate?: boolean) {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, _target: any, propertyKey: string) => {
    if (model.FilterableColumns === undefined) {
      model.FilterableColumns = new Map<string, IColumnFilter<unknown>>();
    }

    let aggregate = isAggregate;

    if (isConstructor(operatorsOrClass)) {
      // if we have @belonsgTo relation we add to this filter schema all avaible filters
      // from the related model
      const descriptor = extractModelDescriptor(operatorsOrClass);
      if (descriptor!.FilterableColumns) {
        const keys = [...descriptor!.FilterableColumns.keys()];
        const ops = keys.map((k) => {
          return [`${propertyKey}.${k}`, descriptor!.FilterableColumns!.get(k)];
        });

        model.FilterableColumns = new Map<string, IColumnFilter<unknown>>([...model.FilterableColumns.entries(), ...(ops as any)]);
      }
    } else {
      const options: IFilterableOptions = Array.isArray(operatorsOrClass) || !operatorsOrClass ? { operators: operatorsOrClass, query: queryFunc } : operatorsOrClass;
      if (!options.operators) {
        throw new Error(`Filterable decorator on ${model.Name} model, property ${propertyKey} must have operators defined`);
      }
      aggregate = options.aggregate ?? aggregate;
      model.FilterableColumns.set(propertyKey, {
        operators: options.operators,
        query: options.query,
        value: options.value,
      });
    }

    const columnDesc = model.Columns.find((c) => c.Name === propertyKey);
    if (!columnDesc) {
      // we dont want to fill all props, they will be loaded from db and mergeg with this
      // Filter-only property: nothing selects, writes or dehydrates it, so it is nullable by construction.
      model.Columns.push(_prepareColumnDesc({ Name: propertyKey, Aggregate: aggregate ?? false, Virtual: true, Nullable: true }));
    } else {
      columnDesc.Aggregate = aggregate ?? false;
    }
  });
}

export function Filter(model: Constructor<ModelBase> | IColumnFilter<unknown>[]) {
  return Route(Parameter('FilterModelRouteArg', null, model));
}

function propertyDecorator(record: (model: IModelDescriptor, propertyKey: string) => void): PropertyDecorator {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, _target: unknown, propertyKey: string) => record(model, propertyKey)) as PropertyDecorator;
}

/** Lets a list be sorted by this column. A model with no `@Sortable` is sortable by its filterable table columns. */
export function Sortable(): PropertyDecorator {
  return propertyDecorator((model, propertyKey) => {
    (model.SortableColumns ??= new Set<string>()).add(propertyKey);
  });
}

/** Lets an aggregate request group by this column. Grouping lists a column's distinct values, so it is opt-in. */
export function Groupable(): PropertyDecorator {
  return propertyDecorator((model, propertyKey) => {
    (model.GroupableColumns ??= new Set<string>()).add(propertyKey);
  });
}

/** Lets an aggregate request apply these functions to this column. */
export function Aggregatable(functions: AggregateFunction[]): PropertyDecorator {
  return propertyDecorator((model, propertyKey) => {
    if (!functions || functions.length === 0) {
      throw new Error(`Aggregatable decorator on ${model.Name} model, property ${propertyKey} must name at least one function`);
    }
    (model.AggregatableColumns ??= new Map<string, AggregateFunction[]>()).set(propertyKey, [...functions]);
  });
}
