import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('twin-b')
export class TwinController extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('twin-b');
  }
}
