import { BasePath, BaseController, Ok, Cookie, Get } from '../../../src';

@BasePath('params/coockie')
export class CoockieParams extends BaseController {
  @Get()
  public simple(@Cookie() name: string) {
    return new Ok({ name });
  }
}
