import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('registered')
export class RegisteredController extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('registered');
  }
}
