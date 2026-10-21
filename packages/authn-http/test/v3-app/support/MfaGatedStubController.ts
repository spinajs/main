import { BaseController, BasePath, Get, Ok, Policy } from '@spinajs/http';

import { Authenticated, MfaSatisfied } from '../../../src/v3/index.js';

// The scan keeps every export that is a controller, so this file exports nothing else.
/** A route behind Authenticated and MfaSatisfied, the gate a step-up opens (A34). */
@BasePath('v3-app-mfa-gated')
export class V3AppMfaGatedStubController extends BaseController {
  @Get('/')
  @Policy([Authenticated, MfaSatisfied])
  public gated() {
    return new Ok({ ok: true });
  }
}
