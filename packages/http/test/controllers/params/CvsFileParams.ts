import { BasePath, BaseController, Ok, CsvFile, Post } from "../../../src";
import { SampleObject } from "../../dto";
import { SampleModel, SampleModelWithSchema, SampleModelWithHydrator } from "../../dto";

@BasePath("params/v1/json")
export class JsonParams extends BaseController {

    @Post()
    public objectsFromCvs(@CsvFile() objects: SampleObject) {
        return new Ok({ objects })
    }

    @Post()
    public modelsFromCvs(@CsvFile() objects: SampleModel) {
        return new Ok({ objects });
    }

    @Post()
    public modelsFromCvsWithSchema(@CsvFile() objects: SampleModelWithSchema) {
        return new Ok({ objects })
    }

    @Post()
    public modelsFromCvsWithHydrator(@CsvFile() objects: SampleModelWithHydrator) {
        return new Ok({ objects })
    }
}