import { BasePath, BaseController, Get, Header, Ok } from '../../../src';
import { SampleObject, SampleModel, SampleModelWithHydrator, SampleObjectSchema } from '../../dto';
import { DateTime } from 'luxon';

@BasePath('params/headers')
export class HeaderParams extends BaseController {
  @Get()
  public headerParamObject(@Header('x-custom-header') val: SampleObject) {
    return new Ok({ val });
  }

  @Get()
  public headerParamModel(@Header('x-custom-header') val: SampleModel) {
    return new Ok({ val });
  }

  @Get()
  public headerParamModelWithHydrator(@Header('x-custom-header') val: SampleModelWithHydrator) {
    return new Ok({ val });
  }

  @Get()
  public headerParamObjectWithSchema(@Header('x-custom-header', SampleObjectSchema) a: SampleObject) {
    return new Ok({ a });
  }

  @Get()
  public headerParamNoName(@Header() customHeaderName: string) {
    return new Ok({ customHeaderName });
  }

  @Get()
  public headerParam(@Header('x-custom-header') val: string) {
    return new Ok({ val });
  }

  @Get()
  public headerDate(@Header('x-custom-header') val: DateTime) {
    return new Ok({ val });
  }
}
