import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('aliased')
class AliasedController extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('aliased');
  }
}

export const Visible = AliasedController;
