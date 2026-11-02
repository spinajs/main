import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('same')
export class SameController extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('same');
  }
}
