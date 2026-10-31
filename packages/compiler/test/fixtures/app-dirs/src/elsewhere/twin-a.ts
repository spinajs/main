import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('twin-a')
export class TwinController extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('twin-a');
  }
}
