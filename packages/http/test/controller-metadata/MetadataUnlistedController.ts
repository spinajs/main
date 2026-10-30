import { BaseController, BasePath, Get, Ok, Query } from '../../src/index.js';

@BasePath('metadata-unlisted')
export class MetadataUnlistedController extends BaseController {
  @Get('ping')
  public ping(@Query() value: string) {
    return new Ok({ value });
  }
}
