import { BaseController, BasePath, Get, Ok, Policy } from '@spinajs/http';
import { AuthorizedTestPolicy, OffHoursTestPolicy, UndocumentedTestPolicy } from '../policies/TestPolicies.js';

/**
 * Demonstrates @Policy applied at both controller and route scopes.
 * @tags PolicyTests
 */
@BasePath('policies')
@Policy(AuthorizedTestPolicy)
export class PolicyController extends BaseController {
  /**
   * Route inherits controller-level policy only.
   */
  @Get('inherited')
  public async inherited() {
    return new Ok({ ok: true });
  }

  /**
   * Route adds an extra route-level policy on top of the controller-level one.
   */
  @Get('combined')
  @Policy(OffHoursTestPolicy)
  public async combined() {
    return new Ok({ ok: true });
  }

  /**
   * Route applies a policy with no JSDoc — exercises the fallback description.
   */
  @Get('undocumented')
  @Policy(UndocumentedTestPolicy)
  public async undocumented() {
    return new Ok({ ok: true });
  }
}
