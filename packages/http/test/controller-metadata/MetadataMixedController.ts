import { BaseController, BasePath, Get, Ok, Parameter, ParameterType, Query, Route } from '../../src/index.js';

/** An argument decorator the compiler does not record, like orm-http's `@Filter` or an app's own. */
function Unrecorded() {
  return Route(Parameter(ParameterType.FromQuery));
}

@BasePath('metadata-mixed')
export class MetadataMixedController extends BaseController {
  @Get('args')
  public args(@Query() first: string, @Unrecorded() second: string, @Query() third: number) {
    return new Ok({ first, second, third });
  }
}
