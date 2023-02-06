import { BaseController, Get, Ok } from '../../src/index.js';

export class TestMethods2 extends BaseController {
  @Get()
  public testGet2() {
    return new Ok();
  }
}
