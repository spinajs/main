import { BasePath, BaseController, Ok, CsvFile, Post } from '../../../src/index.js';
import { SampleObject } from '../../dto/index.js';
import { SampleModel, SampleModelWithSchema, SampleModelWithHydrator } from '../../dto/index.js';

@BasePath('params/v1/json')
export class CvsFileParams extends BaseController {
  @Post()
  public objectsFromCvs(@CsvFile() objects: SampleObject) {
    return new Ok({ objects });
  }

  @Post()
  public modelsFromCvs(@CsvFile() objects: SampleModel) {
    return new Ok({ objects });
  }

  @Post()
  public modelsFromCvsWithSchema(@CsvFile() objects: SampleModelWithSchema) {
    return new Ok({ objects });
  }

  @Post()
  public modelsFromCvsWithHydrator(@CsvFile() objects: SampleModelWithHydrator) {
    return new Ok({ objects });
  }
}
