import { BasePath, BaseController, Ok, CsvFile, Post } from '../../../src/index.js';
import { CvsSampleObject, CvsSampleObjectWithSchema } from '../../dto/index.js';
import { SampleModel, SampleModelWithHydrator } from '../../dto/index.js';

@BasePath('params/cvs')
export class CvsFileParams extends BaseController {
  @Post()
  public objectsFromCvs(@CsvFile() objects: CvsSampleObject) {
    return new Ok({ objects });
  }

  @Post()
  public modelsFromCvs(@CsvFile() objects: SampleModel) {
    return new Ok({ objects });
  }

  @Post()
  public modelsFromCvsWithSchema(@CsvFile() objects: CvsSampleObjectWithSchema) {
    return new Ok({ objects });
  }

  @Post()
  public modelsFromCvsWithHydrator(@CsvFile() objects: SampleModelWithHydrator) {
    return new Ok({ objects });
  }
}
