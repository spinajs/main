import { BaseController, Get, Ok, BasePath, Post, Body } from '@spinajs/http';
import { FromDB } from './../../src/index';
import { Test } from '../models/Test';

@BasePath('simple')
export class Simple extends BaseController {
  @Get(':model')
  public testGet(@FromDB() model: Test) {
    return new Ok({ Text: model.Text });
  }

  @Post()
  public testHydrate(@Body() model: Test) {
    return new Ok({ Text: model.Text });
  }
}