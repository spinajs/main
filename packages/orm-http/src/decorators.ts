import { ColumnName, IModelDescriptor, ModelBase, RelationName, SortOrder, WhereFunction, _prepareColumnDesc, extractDecoratorPropertyDescriptor, extractModelDescriptor, extractModelDescriptorInherited } from '@spinajs/orm';
import { FilterableOperators, IColumnFilter, IncludeRouteArgOptions, SortRouteArgOptions } from './interfaces.js';
import { Constructor, isConstructor } from '@spinajs/di';
import { Parameter, Route } from '@spinajs/http';
import { InvalidArgument } from '@spinajs/exceptions';

// `queryFunc` accepts null so that a column can opt out of a custom query while still
// setting the trailing `isAggregate` flag.
export function Filterable(operatorsOrClass: FilterableOperators[] | Constructor<ModelBase>, queryFunc?: ((operator: FilterableOperators, value: any) => WhereFunction<unknown>) | null, isAggregate?: boolean) {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, _target: any, propertyKey: string) => {
    if (model.FilterableColumns === undefined) {
      model.FilterableColumns = new Map<string, IColumnFilter<unknown>>();
    }

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
      // Filter-only property: nothing selects, writes or dehydrates it, so it is nullable by construction.
      model.Columns.push(_prepareColumnDesc({ Name: propertyKey, Aggregate: isAggregate ?? false, Virtual: true, Nullable: true }));
    } else {
      columnDesc.Aggregate = isAggregate ?? false;
    }
  });
}

export function Filter(model: Constructor<ModelBase> | IColumnFilter<unknown>[]) {
  return Route(Parameter('FilterModelRouteArg', null, model));
}

/** A sort request. The type admits any column of `M`; `@Sort` narrows it to the `@Sortable()` ones at runtime. */
export interface Sort<M = unknown> {
  column: ColumnName<M>;
  order: SortOrder;
}

export interface SortDecoratorOptions<C extends Constructor<ModelBase>> {
  /** Column used when the request names none. Must be `@Sortable()`. */
  default: ColumnName<InstanceType<C>>;

  /** Order used when the request names none. Default ASC. */
  order?: SortOrder;

  /**
   * The model the route actually queries, when an application can replace `model` with a subclass (a DI-registered
   * model class). Resolved per request; its `@Sortable()` columns, inherited ones included, are the allowlist.
   */
  resolve?: () => C;

  /** Query key the sort is read from. Default `order`, the key `@Query() order?: OrderDTO` reads. */
  field?: string;
}

const sortableCache = new WeakMap<object, readonly string[]>();

function sortableOf(model: Constructor<ModelBase>): readonly string[] {
  let columns = sortableCache.get(model);
  if (!columns) {
    columns = Object.freeze([...(extractModelDescriptorInherited(model)?.Sortable ?? [])]);
    sortableCache.set(model, columns);
  }
  return columns;
}

/**
 * Reads `?order={"column":"Login","order":"desc"}` into a {@link Sort} of `model`. A column that is not
 * `@Sortable()` on the model (on `resolve()`'s model when given), or an order other than ASC / DESC, answers 400;
 * a missing one takes the default.
 *
 * The model's sortable columns are read here, when the controller class is defined: a default that is not
 * sortable, or a model with no sortable column, fails the import of the controller instead of a request.
 */
export function Sort<C extends Constructor<ModelBase>>(model: C, options: SortDecoratorOptions<C>) {
  if (!model) {
    // A circular import hands the decorator the model before its module has run.
    throw new InvalidArgument(`@Sort: the model is undefined (default column '${options.default}'), check for a circular import`);
  }

  const sortable = [...(extractModelDescriptorInherited(model)?.Sortable ?? [])];
  const fallback: string = options.default;
  const resolve = options.resolve;

  if (sortable.length === 0) {
    throw new InvalidArgument(`@Sort(${model.name}): the model declares no @Sortable() column`);
  }

  if (!sortable.includes(fallback)) {
    throw new InvalidArgument(`@Sort(${model.name}): default column '${fallback}' is not @Sortable(). Sortable columns are: ${sortable.join(', ')}`);
  }

  const routeOptions: SortRouteArgOptions = {
    model,
    sortable,
    columns: () => {
      if (!resolve) {
        return sortable;
      }

      const resolved = resolve();
      const columns = sortableOf(resolved);
      if (!columns.includes(fallback)) {
        // Only a model outside `model`'s hierarchy can lack the default; that is a server misconfiguration, not a 400.
        throw new Error(`@Sort(${model.name}): default column '${fallback}' is not @Sortable() on the resolved model ${resolved.name}`);
      }
      return columns;
    },
    default: fallback,
    order: options.order ?? SortOrder.ASC,
    field: options.field ?? 'order',
  };

  return Route(Parameter('SortRouteArg', null, routeOptions));
}

export interface IncludeDecoratorOptions {
  /** Query key the relations are read from. Default `include`. */
  field?: string;
}

/**
 * Reads the relations a request asks to populate: `?include=Metadata`, repeated `?include=A&include=B` or a
 * JSON array `?include=["A","B"]`. A name outside `relations` answers 400; no include is an empty array.
 */
export function Include<C extends Constructor<ModelBase>>(model: C, relations: readonly RelationName<InstanceType<C>>[], options: IncludeDecoratorOptions = {}) {
  const routeOptions: IncludeRouteArgOptions = {
    model,
    relations: [...relations],
    field: options.field ?? 'include',
  };

  return Route(Parameter('IncludeRouteArg', null, routeOptions));
}
