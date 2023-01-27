import { BasePath, BaseController, Ok, FromDI, Get } from '../../../src/index.js';
import { SomeService } from '../../service/SomeService.js';

@BasePath('params/v1/forms')
export class InjectParams extends BaseController {
  @Get()
  public testInject(@FromDI() _someService: SomeService) {
    return new Ok();
  }
}
