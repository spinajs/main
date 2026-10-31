import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('local-own')
export class LocalController extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('local-own');
  }
}

export * from '../elsewhere/local-other.js';
