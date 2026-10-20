import { BaseController, BasePath, Get, Ok, Policy } from '@spinajs/http';

import { Authenticated } from '../../../src/v3/index.js';

// The scan keeps every export that is a controller, so this file exports nothing else.
/** A route behind Authenticated only, for the token end-to-end suite: any principal kind may reach it. */
@BasePath('v3-app-token-e2e')
export class V3AppTokenE2eController extends BaseController {
  @Get('data')
  @Policy(Authenticated)
  public data() {
    return new Ok({ ok: true });
  }
}
