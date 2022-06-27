import { BasePath, BaseController, Post, Body, Param, Header, Query, Ok } from '../../../src';
import { SampleModel } from '../../dto';

@BasePath('params/v1/forms')
export class MixedParams extends BaseController {
  @Post('/:id')
  public mixedArgs(@Body() model: SampleModel, @Param() id: number, @Header('x-header') header: string, @Query() queryString: string) {
    return new Ok({ model, id, header, queryString });
  }
}
