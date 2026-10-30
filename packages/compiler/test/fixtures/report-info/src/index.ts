import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('opaque')
export class OpaqueController extends BaseController {
  @Get('/')
  public async read(): Promise<Ok<{ value: unknown }>> {
    return new Ok({ value: 1 });
  }
}
