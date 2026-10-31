import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('type-only')
export class TypeOnlyController extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('type-only');
  }
}
