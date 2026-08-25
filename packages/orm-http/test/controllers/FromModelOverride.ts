import { BaseController, Get, Ok, BasePath } from '@spinajs/http';
import { FromModel } from './../../src/index.js';
import { Test } from '../models/Test.js';
import { Test5 } from '../models/Test5.js';

/**
 * Demonstrates `@FromModel({ model })`: the override route resolves through `Test5`
 * (a DI-registered subclass) instead of the parameter's reflected `Test` type - the same
 * seam Task 4 uses for `RbacUserModel`.
 *
 * NOTE: not exercised over HTTP by `from-model-override.test.ts` - see that file's header
 * comment for why. Kept here as the production-representative registration this option is
 * built for, and it is picked up automatically whenever this package's HttpServer harness
 * (`orm-http.test.ts`) resolves `Controllers` against `test/controllers`.
 */
@BasePath('from-model-override')
export class FromModelOverrideController extends BaseController {
  @Get(':id')
  public async byReflectedType(@FromModel() id: Test) {
    return new Ok({ model: id.constructor.name });
  }

  @Get('override/:id')
  public async byOverride(@FromModel({ model: () => Test5 }) id: Test) {
    return new Ok({ model: id.constructor.name });
  }
}
