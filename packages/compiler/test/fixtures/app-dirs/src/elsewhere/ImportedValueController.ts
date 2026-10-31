import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('imported-value')
export class ImportedValueController extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('imported-value');
  }
}
