import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('specifier-type')
export class SpecifierTypeController extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('specifier-type');
  }
}
