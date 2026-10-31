import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('typestar')
export class TypeStarController extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('typestar');
  }
}
