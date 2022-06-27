import { BasePath, BaseController, Ok, JsonFile, Post} from "../../../src";
import { SampleObject } from "../../dto";
import { SampleModel, SampleModelWithSchema, SampleModelWithHydrator } from "../../dto";

@BasePath("params/v1/json")
export class JsonParams extends BaseController {

    @Post()
    public objectsFromJsonFile(@JsonFile() objects: SampleObject) {
        return new Ok({ objects })
    }

    @Post()
    public modelsFromJsonFile(@JsonFile() objects: SampleModel) {
        return new Ok({ objects })
    }

    @Post()
    public modelsFromJsonFileWithSchema(@JsonFile() objects: SampleModelWithSchema) {
        return new Ok({ objects })
    }

    @Post()
    public modelsFromJsonFileWithHydrator(@JsonFile() objects: SampleModelWithHydrator) {
        return new Ok({ objects })
    }
}