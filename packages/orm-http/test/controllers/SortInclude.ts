import { BaseController, Get, Ok, BasePath } from '@spinajs/http';
import { RelationName, Sortable, SortOrder } from '@spinajs/orm';
import { Include, Sort } from './../../src/index.js';
import { Sorted } from '../models/Sorted.js';

/** A subclass an application could register in place of Sorted; no @Model, so the orm never queries it. */
export class SortedWithSecret extends Sorted {
  @Sortable()
  public Secret: string;
}

/** The model the resolved route sorts; tests swap it. */
export const sortModel: { current: typeof Sorted } = { current: Sorted };

@BasePath('sort-include')
export class SortIncludeC extends BaseController {
  @Get()
  public sorted(@Sort(Sorted, { default: 'Name', order: SortOrder.DESC }) sort: Sort<Sorted>) {
    return new Ok(sort);
  }

  @Get()
  public sortedBy(@Sort(Sorted, { default: 'Id', field: 'sortBy' }) sort: Sort<Sorted>) {
    return new Ok(sort);
  }

  @Get()
  public sortedResolved(@Sort(Sorted, { default: 'Name', resolve: () => sortModel.current }) sort: Sort<Sorted>) {
    return new Ok(sort);
  }

  @Get()
  public included(@Include(Sorted, ['Belongs', 'TestsTwos']) include: RelationName<Sorted>[]) {
    return new Ok({ include });
  }
}
