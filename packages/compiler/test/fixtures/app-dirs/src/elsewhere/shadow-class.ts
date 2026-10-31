import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('shadow')
export class ShadowController extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('shadow');
  }
}
