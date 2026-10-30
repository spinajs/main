import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('old')
export class OldController extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('old');
  }
}
