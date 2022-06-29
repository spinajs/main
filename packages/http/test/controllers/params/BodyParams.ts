import { BaseController, BasePath, Body, Ok, Post, Type } from '../../../src';
import { SampleModel, SampleModelWithHydrator, SampleModelWithSchema, SampleObject, SampleObjectSchema } from '../../dto';

@BasePath('params/body')
export class BodyParams extends BaseController {
  @Post()
  public simple(@Body() id: number) {
    return new Ok({ id });
  }

  @Post()
  public bodyObject(@Body() object: SampleObject) {
    return new Ok({ object });
  }

  @Post()
  public multipleBodyObjects(@Body() object1: SampleObject, @Body() object2: SampleObject) {
    return new Ok({ object1, object2 });
  }

  @Post()
  public bodyModel(@Body() object1: SampleModel) {
    return new Ok({ object1 });
  }

  @Post()
  public multipleBodyModel(@Body() object1: SampleModel, @Body() object2: SampleModel) {
    return new Ok({ object1, object2 });
  }

  @Post()
  public bodyArray(@Body() objects: SampleModel[]) {
    return new Ok({ objects });
  }

  @Post()
  public bodyModelWithHydrator(@Body() object: SampleModelWithHydrator) {
    return new Ok({ object });
  }

  @Post()
  public bodyObjectWithSchema(@Body(SampleObjectSchema) object: SampleObject) {
    return new Ok({ object });
  }

  @Post()
  public bodyModelWithSchema(@Body() object: SampleModelWithSchema) {
    return new Ok({ object });
  }

  @Post()
  public arrayOfHydratedModels(
    @Body()
    @Type(Array.ofType(SampleModelWithHydrator))
    objects: SampleModelWithHydrator[],
  ) {
    return new Ok({ objects });
  }
}
