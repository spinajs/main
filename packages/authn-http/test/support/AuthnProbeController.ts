import { BaseController, BasePath, Del, Get, Ok, Patch, Post, Put, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';

import { AUTHN_PROBE_PATH, probeBody } from '../v3/probe.js';

// The controller scan takes a file's first export, so this file exports nothing else.
/** Test-only route: every method, no policy. */
@BasePath(AUTHN_PROBE_PATH)
export class AuthnProbeController extends BaseController {
  @Get('/')
  public async probeGet(@Req() req: Request) {
    return new Ok(probeBody(req));
  }

  @Post('/')
  public async probePost(@Req() req: Request) {
    return new Ok(probeBody(req));
  }

  @Put('/')
  public async probePut(@Req() req: Request) {
    return new Ok(probeBody(req));
  }

  @Patch('/')
  public async probePatch(@Req() req: Request) {
    return new Ok(probeBody(req));
  }

  @Del('/')
  public async probeDelete(@Req() req: Request) {
    return new Ok(probeBody(req));
  }
}
