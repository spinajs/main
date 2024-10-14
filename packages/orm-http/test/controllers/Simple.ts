import { BaseController, Get, Ok, BasePath, Post, Body, Query, Param } from '@spinajs/http';
import { FromModel } from './../../src/index.js';
import { Test } from '../models/Test.js';

@BasePath('simple')
export class Simple extends BaseController {
  @Get(':model')
  public testGet(@FromModel() model: Test) {
    return new Ok({ Text: model.Text });
  }

  @Post()
  public testHydrate(@Body() model: Test) {
    return new Ok({ Text: model.Text });
  }

  @Get('testinclude/:model')
  public testInclude(@FromModel() model: Test, @Query() _include: string[]) {
    return new Ok(model.dehydrateWithRelations());
  }

  @Get('testWithParent/:belongs/:model')
  public testWithParent(@FromModel() model: Test, @Param() _belongs: number) {
    return new Ok(model.dehydrateWithRelations());
  }
}
