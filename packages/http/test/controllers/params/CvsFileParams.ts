import { BasePath, BaseController, Ok, CsvFile, Post, Type } from '../../../src/index.js';
import { CvsSampleObject, CvsSampleObjectWithHydrator, CvsSampleObjectWithSchema, CvsSampleObjectWithSchemaSchema, SampleCvsModel } from '../../dto/index.js';

const CVS_PARSE_OPTIONS = { from: 2, delimiter: ';',cast: true, auto_parse: true, columns: ['Username', 'Identifier', 'FirstName', 'LastName'] };
const CVS_PARSE_OPTIONS_WITH_SCHEMA = { ...CVS_PARSE_OPTIONS, Schema: CvsSampleObjectWithSchemaSchema };

@BasePath('params/cvs')
export class CvsFileParams extends BaseController {
  @Post()
  public objectsFromCvs(@CsvFile(CVS_PARSE_OPTIONS) objects: CvsSampleObject[]) {
    return new Ok({ objects });
  }

  @Post()
  public modelsFromCvs(@CsvFile(CVS_PARSE_OPTIONS) @Type(SampleCvsModel) objects: SampleCvsModel[]) {
    return new Ok({ objects });
  }

  @Post()
  public modelsFromCvsWithSchema(@CsvFile(CVS_PARSE_OPTIONS) @Type(CvsSampleObjectWithSchema)  objects: CvsSampleObjectWithSchema[]) {
    return new Ok({ objects });
  }

  /**
   * Test endpoint that uses TypedArray (Array.ofType) to preserve type information at runtime.
   * This allows schema extraction from the underlying type for array parameters.
   */
  @Post()
  public modelsFromCvsWithTypedArray(@CsvFile(CVS_PARSE_OPTIONS) @Type(Array.ofType(CvsSampleObjectWithSchema)) objects: CvsSampleObjectWithSchema[]) {
    return new Ok({ objects });
  }

  @Post()
  public modelsFromCvsWithHydrator(@CsvFile(CVS_PARSE_OPTIONS) objects: CvsSampleObjectWithHydrator) {
    return new Ok({ objects });
  }

  @Post()
  public objectsFromCvsWithSchemaOption(@CsvFile(CVS_PARSE_OPTIONS_WITH_SCHEMA) objects: CvsSampleObject[]) {
    return new Ok({ objects });
  }
}
