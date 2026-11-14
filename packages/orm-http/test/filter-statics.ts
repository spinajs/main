import { ISelectQueryBuilder, ModelBase } from '@spinajs/orm';
import { MODEL_STATIC_MIXINS } from '../src/model.js';
import { FilterableLogicalOperators, IColumnFilter, IFilterEntry, IFilterRequest } from '../src/interfaces.js';

/** The filter statics orm-http's bootstrapper installs on a model, and `query().filter()`, typed by the model. */
export interface FilterStatics<M extends ModelBase> {
  filterSchema(): object;
  filterColumns(): IColumnFilter<unknown>[];
  filter(request?: IFilterRequest): Promise<M[]>;
  query(filters?: IFilterEntry[] | null, op?: FilterableLogicalOperators): ISelectQueryBuilder<M[]>;
}

/** Installs the statics on `model`, as the bootstrapper does in a full app boot. */
export function installFilterStatics<T extends typeof ModelBase>(model: T): FilterStatics<InstanceType<T>> {
  for (const [name, mixin] of Object.entries(MODEL_STATIC_MIXINS)) {
    Object.defineProperty(model, name, { value: mixin.bind(model), configurable: true, writable: true });
  }

  return {
    filterSchema: () => MODEL_STATIC_MIXINS.filterSchema.call(model),
    filterColumns: () => MODEL_STATIC_MIXINS.filterColumns.call(model),
    filter: (request) => model.filter<InstanceType<T>>(request),
    query: (filters, op) => model.query().filter(filters, op),
  };
}
