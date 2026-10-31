import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('elsewhere-admin')
export class AdminController extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('elsewhere-admin');
  }
}
