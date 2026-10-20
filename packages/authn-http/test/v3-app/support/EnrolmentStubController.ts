import { BaseController, BasePath, Ok, Policy, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';

import { Authenticated, PendingMfaEnrolment } from '../../../src/v3/index.js';

// The scan keeps every export that is a controller, so this file exports nothing else.
/** Stands in for N8b's enrolment route: a logged-in caller, or a pending session the MFA policy forces to enrol. */
@BasePath('v3-app-enrol-stub')
export class V3AppEnrolmentStubController extends BaseController {
  @Post('/')
  @Policy(Authenticated)
  @Policy(PendingMfaEnrolment)
  public enrol(@Req() req: Request) {
    return new Ok({ identity: req.storage.AuthnSession?.identity ?? null, principal: req.storage.AuthnPrincipal?.id ?? null });
  }
}
