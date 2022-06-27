import { SamplePolicy } from './../policies/SamplePolicy';
import { BaseController, Get, Ok, Policy } from "../../src";


@Policy(SamplePolicy)
export class TestPolicy extends BaseController {

    @Get()
    public testGet() {
        return new Ok();
    }
}