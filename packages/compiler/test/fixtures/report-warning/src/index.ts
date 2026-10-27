import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('untyped')
export class UntypedController extends BaseController {
  @Get('/')
  public async read(): Promise<Ok<{ value: any }>> {
    return new Ok({ value: 1 });
  }
}
