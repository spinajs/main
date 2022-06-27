import { BasePath, BaseController, Ok, FromDI, Get } from '../../../src';
import { SomeService } from '../../service/SomeService';

@BasePath('params/v1/forms')
export class InjectParams extends BaseController {
  @Get()
  public testInject(@FromDI() _someService: SomeService) {
    return new Ok();
  }
}
