import { BasePath, BaseController, Get, Ok, Param, PKey, Uuid } from '../../../src/index.js';
import { SampleModelWithHydrator2 } from '../../dto/index.js';

@BasePath('params/url')
export class UrlParams extends BaseController {
  @Get('simple/:id')
  public simple(@Param() id: number) {
    return new Ok({ id });
  }

  @Get('paramWithHydrator/:model')
  public paramWithHydrator(@Param() model: SampleModelWithHydrator2) {
    return new Ok({ model });
  }

  @Get('paramWithSchema/:id')
  public paramWithSchema(
    @Param({
      type: 'number',
      minimum: 0,
      maximum: 999,
    })
    id: number,
  ) {
    return new Ok({ id });
  }

  @Get('multipleParam/:param/:param2/:param3')
  public multipleParam(@Param() param: number, @Param() param2: string, @Param() param3: boolean) {
    return new Ok({ param, param2, param3 });
  }

  @Get('pkey/:id')
  public pkey(@PKey() id: number) {
    return new Ok({ id });
  }

  @Get('uuid/:id')
  public uuid(@Uuid() id: string) {
    return new Ok({ id });
  }
}
