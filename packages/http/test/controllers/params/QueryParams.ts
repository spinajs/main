import { DateTime } from './../../../src/datetime';
import { ParameterType } from '../../../src/interfaces';
import { BasePath, BaseController, Get, Query, Ok, Uuid, PKey } from "../../../src";
import { SampleObject, SampleModel, SampleObjectSchema, SampleModelWithSchema } from "../../dto";

@BasePath("params/v1/query")
export class QueryParams extends BaseController {

    @Get()
    public query(@Query() a: string, @Query() b: boolean, @Query() c: number) {
        return new Ok({ a, b, c });
    }

    @Get()
    public queryObject(@Query() a: SampleObject) {
        return new Ok({ a });
    }

    @Get()
    public queryModel(@Query() a: SampleModel) {
        return new Ok({ a });
    }

    @Get()
    public queryMixedData(@Query() a: SampleModel, @Query() b: SampleObject, @Query() c: string) {
        return new Ok({ a, b, c });
    }

    @Get()
    public queryObjectWithSchema(@Query(SampleObjectSchema) a: SampleObject) {
        return new Ok({ a });
    }

    @Get()
    public queryModelWithSchema(@Query() a: SampleModelWithSchema) {
        return new Ok({ a });
    }

    @Get()
    public queryDate(@Query() a: DateTime.FromISO) {
        return new Ok({ a });
    }

    @Get()
    public queryDateFromUnixtime(@Query() a: DateTime.FromUnix) {
        return new Ok({ a });
    }

    @Get()
    public queryUuid(@Uuid(ParameterType.FromQuery) a: string) {
        return new Ok({ a });
    }

    @Get()
    public pkey(@PKey(ParameterType.FromQuery) id: number) {
        return new Ok({ id })
    }

}