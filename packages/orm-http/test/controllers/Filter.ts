import { BaseController, Get, Ok, BasePath } from '@spinajs/http';
import { IFilter, Filter } from './../../src/index.js';
import { FilterableModel } from '../models/Filterable.js';
import { Test } from '../models/Test.js';
import { Test2 } from '../models/Test2.js';
import { Belongs } from '../models/Belongs.js';

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
        column: 'Foo',
        operators: ['eq', 'gt'],
      },
    ])
    filter: IFilter[],
  ) {
    return new Ok(filter);
  }

  @Get()
  public testRelationFilterOneToMany(
    @Filter(Test2)
    filter: IFilter[],
  ) {


    Test.select().populate("TestsTwos", function () {
      this.filter(filter);
    });

    return new Ok();
  }

  @Get()
  public testRelationFilterOneToOne(
    @Filter(Belongs)
    filter: IFilter[],
  ) {

    Test.select().populate("Belongs", function () {
      this.filter(filter);
    });

    return new Ok();
  }
}
