import { SampleMiddleware } from './../middlewares/SampleMiddleware.js';
import { BaseController, Get, Ok, Middleware } from '../../src/index.js';

@Middleware(SampleMiddleware)
export class TestMiddleware extends BaseController {
  @Get()
  public testGet() {
    return new Ok();
  }

  @Get()
  public testGet2() {
    return new Ok();
  }
}
