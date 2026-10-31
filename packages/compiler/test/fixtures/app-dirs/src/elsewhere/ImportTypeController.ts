import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('import-type')
export class ImportTypeController extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('import-type');
  }
}
