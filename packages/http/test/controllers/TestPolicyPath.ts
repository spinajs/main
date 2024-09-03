import { SamplePolicy3 } from './../policies/SamplePolicy3.js';
import { BaseController, Get, Ok, Policy } from '../../src/index.js';
import { SamplePolicy2 } from '../policies/SamplePolicy2.js';

export class TestPolicyPath extends BaseController {
  @Get()
  @Policy(SamplePolicy2)
  public testGet() {
    return new Ok();
  }

  @Get()
  public testGet2() {
    return new Ok();
  }

  @Get()
  @Policy(SamplePolicy3)
  public testGet3() {
    return new Ok();
  }

  @Get()
  @Policy(SamplePolicy3)
  @Policy(SamplePolicy2)
  public testMultiplePolicies(){
    return new Ok();
  }
}
