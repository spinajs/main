import { BaseController, Get, Ok, BasePath } from '@spinajs/http';
import { RelationName, SortOrder } from '@spinajs/orm';
import { Include, Sort } from './../../src/index.js';
import { Sorted } from '../models/Sorted.js';

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
  public included(@Include(Sorted, ['Belongs', 'TestsTwos']) include: RelationName<Sorted>[]) {
    return new Ok({ include });
  }
}
