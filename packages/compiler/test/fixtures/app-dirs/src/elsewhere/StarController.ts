import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('star')
export class StarController extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('star');
  }
}
