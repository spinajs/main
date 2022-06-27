import { BaseController, Get, Post, Head, Patch, Del, Put, Ok } from "../../src";


export class Test2 extends BaseController {

    @Get()
    public testGet() {
        return new Ok();
    }

    @Post()
    public testPost() {
        return new Ok();
    }

    @Head()
    public testHead() {
        return new Ok();
    }

    @Patch()
    public testPatch() {
        return new Ok();
    }


    @Del()
    public testDel() {
        return new Ok();
    }

    @Put()
    public testPut() {
        return new Ok();
    }
}