import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

@BasePath('hidden')
class HiddenController extends BaseController {
  @Get()
  public async get(): Promise<Ok<string>> {
    return new Ok('hidden');
  }
}

void HiddenController;
export {};
