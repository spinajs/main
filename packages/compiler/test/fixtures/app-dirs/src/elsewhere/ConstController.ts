import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('const')
export class ConstController extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('const');
  }
}
