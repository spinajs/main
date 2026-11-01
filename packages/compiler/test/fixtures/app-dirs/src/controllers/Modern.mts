import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('modern')
export class ModernController extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('modern');
  }
}
