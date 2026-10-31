import { DI } from '@spinajs/di';
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('debug')
export class DebugController extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('debug');
  }
}

export function enableDebug(): void {
  if (process.env.ENABLE_DEBUG === '1') DI.register(DebugController).as(BaseController);
}
