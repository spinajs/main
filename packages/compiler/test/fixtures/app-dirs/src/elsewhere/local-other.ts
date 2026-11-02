import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('local-other')
export class LocalController extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('local-other');
  }
}
