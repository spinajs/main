import { BaseController, Get, Ok, Policy } from "../../src";
import { SamplePolicy2 } from '../policies/SamplePolicy2';


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
}