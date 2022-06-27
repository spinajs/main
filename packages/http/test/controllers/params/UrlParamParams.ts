import { ParameterType } from '../../../src/interfaces';
import { DateTime } from "luxon";
import { BasePath, BaseController, Get, Query, Ok, Uuid, Param, PKey } from "../../../src";
import { SampleObject, SampleModel, SampleModelWithHydrator, SampleObjectSchema, SampleModelWithSchema } from "../../dto";

@BasePath("params/v1/urlparams")
export class QueryParams extends BaseController {

    @Get("/:id")
    public param(@Param() id: number) {
        return new Ok({ id });
    }

    @Get("/:id")
    public paramWithHydrator(@Param() model: SampleModelWithHydrator) {
        return new Ok({ model });
    }

    @Get("/:id")
    public paramWithSchema(@Param({
        type: "number",
        min: 0,
        max: 999
    }) id: number) {
        return new Ok({ id });
    }

    @Get("/:param/:param2/:param3")
    public multipleParam(@Param() param: number, @Param() param2: string, @Param() param3: boolean) {
        return new Ok({ param, param2, param3 });
    }
    
    @Get("/:id")
    public pkey(@PKey() id: number) {
        return new Ok({ id })
    }
}