import { SampleMiddleware2 } from '../middlewares/SampleMiddleware2';
import { BaseController, Get, Ok, Middleware } from '../../src';

export class TestMiddlewarePath extends BaseController {
  @Get()
  @Middleware(SampleMiddleware2)
  public testGet() {
    return new Ok();
  }

  @Get()
  public testGet2() {
    return new Ok();
  }
}
