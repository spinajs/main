import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('barrelled')
export class BarrelledController extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('barrelled');
  }
}
