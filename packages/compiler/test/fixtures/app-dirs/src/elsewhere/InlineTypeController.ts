import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('inline-type')
export class InlineTypeController extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('inline-type');
  }
}
