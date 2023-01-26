import { SamplePolicy } from './../policies/SamplePolicy.js';
import { BaseController, Get, Ok, Policy } from '../../src/index.js';

@Policy(SamplePolicy)
export class TestPolicy extends BaseController {
  @Get()
  public testGet() {
    return new Ok();
  }

  @Get()
  public testGet2() {
    return new Ok();
  }
}
