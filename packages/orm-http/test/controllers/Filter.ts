import { BaseController, Get, Ok, BasePath } from '@spinajs/http';
import { Filter, IFilterRequest } from './../../src/index.js';
import { FilterableModel } from '../models/Filterable.js';
import { Test } from '../models/Test.js';
import { Test2 } from '../models/Test2.js';
import { Belongs } from '../models/Belongs.js';

@BasePath('filter')
export class FilterC extends BaseController {
  @Get()
  public testFilter(@Filter(FilterableModel) filter: IFilterRequest) {
    return new Ok(filter);
  }

  @Get()
  public testCustomFilter(
    @Filter([
      {
        column: 'Foo',
        operators: ['eq', 'gt'],
      },
    ])
    filter: IFilterRequest,
  ) {
    return new Ok(filter);
  }

  @Get()
  public testRelationFilterOneToMany(
    @Filter(Test2)
    filter: IFilterRequest,
  ) {


    Test.select().populate("TestsTwos", function () {
      this.filter(filter.filters, filter.op);
    });

    return new Ok();
  }

  @Get()
  public testRelationFilterOneToOne(
    @Filter(Belongs)
    filter: IFilterRequest,
  ) {

    Test.select().populate("Belongs", function () {
      this.filter(filter.filters, filter.op);
    });

    return new Ok();
  }
}
