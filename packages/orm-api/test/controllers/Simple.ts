import { BaseController, Get, Ok, BasePath, Post, Body } from '@spinajs/http';
import { FromModel } from '../../src/index.js';
import { Test } from '../models/Test.js';

@BasePath('simple')
export class Simple extends BaseController {
  @Get(':model')
  public testGet(@FromModel() model: Test) {
    return new Ok({ Text: model.Text });
  }

  @Get(':model')
  public testWithInclude(_include: string, @FromModel() model: Test) {
    return new Ok({ Text: model.Text });
  }

  @Get(':owner/:model')
  public testWithParentRelation(_belongs : number, @FromModel() model: Test) {
    return new Ok({ Text: model.Text });
  }

  @Post()
  public testHydrate(@Body() model: Test) {
    return new Ok({ Text: model.Text });
  }
}
