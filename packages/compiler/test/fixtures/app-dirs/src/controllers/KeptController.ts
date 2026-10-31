import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('kept')
export class KeptController extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('kept');
  }
}
