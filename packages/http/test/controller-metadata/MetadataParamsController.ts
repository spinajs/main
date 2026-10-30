import { BaseController, BasePath, Get, Ok, Query } from '../../src/index.js';

@BasePath('metadata-params')
export class MetadataParamsController extends BaseController {
  @Get('query')
  public query(@Query() a: string, @Query() b: number) {
    return new Ok({ a, b });
  }
}
