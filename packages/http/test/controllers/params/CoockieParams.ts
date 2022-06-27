import { BasePath, BaseController, Ok, Cookie, Get } from '../../../src';

@BasePath('params/v1/coockie')
export class CoockieParams extends BaseController {
  @Get()
  public cockie(@Cookie() name: string) {
    return new Ok({ name });
  }
}
