import { BasePath, BaseController, Ok, Cookie, Get } from '../../../src/index.js';

@BasePath('params/coockie')
export class CoockieParams extends BaseController {
  @Get()
  public simple(@Cookie() name: string) {
    return new Ok({ name });
  }

  @Get()
  public signed(@Cookie(true) name: string) {
    return new Ok({ name });
  }
}
