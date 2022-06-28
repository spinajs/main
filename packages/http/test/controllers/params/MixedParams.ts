import { BasePath, BaseController, Post, Body, Param, Header, Query, Ok } from '../../../src';
import { SampleModel } from '../../dto';

@BasePath('params/mixed')
export class MixedParams extends BaseController {
  @Post('mixedArgs/:id')
  public mixedArgs(@Body() model: SampleModel, @Param() id: number, @Header('x-header') header: string, @Query() queryString: string) {
    return new Ok({ model, id, header, queryString });
  }
}
