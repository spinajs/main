import { Injectable } from '@spinajs/di';
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@Injectable(BaseController)
@BasePath('injectable')
export class InjectableNeverImported extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('injectable');
  }
}
