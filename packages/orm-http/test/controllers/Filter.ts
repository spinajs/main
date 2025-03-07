import { BaseController, Get, Ok, BasePath } from '@spinajs/http';
import { IFilter, Filter } from './../../src/index.js';
import { FilterableModel } from '../models/Filterable.js';

@BasePath('filter')
export class FilterC extends BaseController {
  @Get()
  public testFilter(@Filter(FilterableModel) filter: IFilter[]) {
    return new Ok(filter);
  }

  @Get()
  public testCustomFilter(
    @Filter([
      {
        Column: 'Foo',
        Operators: ['eq', 'gt'],
      },
    ])
    filter: IFilter[],
  ) {
    return new Ok(filter);
  }
}
