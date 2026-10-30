import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('real')
export class RealController extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('real');
  }
}

@BasePath('base')
export abstract class AbstractBaseController extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('base');
  }
}
