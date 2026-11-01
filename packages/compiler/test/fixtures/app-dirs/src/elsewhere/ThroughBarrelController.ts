import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('through-barrel')
export class ThroughBarrelController extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('through-barrel');
  }
}
