import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('side-effect')
export class SideEffectController extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('side-effect');
  }
}
