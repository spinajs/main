import { BaseController, BasePath, Del, Ok, Param, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';

import { probeBody } from '../v3/probe.js';

// The controller scan takes a file's first export, so this file exports nothing else.
/** Test-only stand-in for authn-oidc's link routes (N10): cookie requests there fall under the general CSRF rule. */
@BasePath('auth/oidc')
export class OidcLinkProbeController extends BaseController {
  @Post(':provider/link')
  public async probeLink(@Param() _provider: string, @Req() req: Request) {
    return new Ok(probeBody(req));
  }

  @Del(':provider/link')
  public async probeUnlink(@Param() _provider: string, @Req() req: Request) {
    return new Ok(probeBody(req));
  }
}
