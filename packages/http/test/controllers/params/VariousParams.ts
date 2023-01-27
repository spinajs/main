import { SomeService } from '../../service/SomeService.js';
import { BasePath, BaseController, Post, Body, Param, Header, Query, Ok, Get, FromDI } from '../../../src/index.js';
import { SampleModel } from '../../dto/index.js';

@BasePath('params/mixed')
export class VariousParams extends BaseController {
  @Post('mixedArgs/:id')
  public mixedArgs(@Body() model: SampleModel, @Param() id: number, @Header('x-header') header: string, @Query() queryString: string) {
    return new Ok({ model, id, header, queryString });
  }

  @Get('di')
  public di(@FromDI() _: SomeService) {
    return new Ok();
  }
}
