import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('shop')
export class ShopController extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('shop');
  }
}
