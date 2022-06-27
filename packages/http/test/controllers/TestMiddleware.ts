import { SampleMiddleware } from './../middlewares/SampleMiddleware';
import { BaseController, Get, Ok, Middleware } from '../../src';

@Middleware(SampleMiddleware)
export class TestMiddleware extends BaseController {
  @Get()
  public testGet() {
    return new Ok();
  }
}
