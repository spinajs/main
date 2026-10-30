import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('elsewhere')
export class ElsewhereController extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('elsewhere');
  }
}
