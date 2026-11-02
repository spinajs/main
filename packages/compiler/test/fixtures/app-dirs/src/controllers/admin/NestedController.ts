import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('nested')
export class NestedController extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('nested');
  }
}
