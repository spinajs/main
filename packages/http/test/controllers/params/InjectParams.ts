import { BasePath, BaseController, Ok, FromDI, Get } from '../../../src/index.js';
import { SomeService } from '../../service/SomeService.js';

@BasePath('params/inject')
export class InjectParams extends BaseController {
  @Get()
  public di(@FromDI() _someService: SomeService) {
    return new Ok();
  }
}
