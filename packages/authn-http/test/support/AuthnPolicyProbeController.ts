import { BaseController, BasePath, Get, Ok, Policy, Post } from '@spinajs/http';
import type { SessionHandle } from '@spinajs/authn/contracts';

import { Authenticated, AuthnSession, FromSession, Identity, NoImpersonationPolicy, NoSession, NoTokenAuthPolicy, NotLoggedPolicy, SessionId } from '../../src/v3/index.js';
import type { AuthnIdentity } from '../../src/v3/index.js';
import { POLICY_PROBE_PATH, SuiteFreshAuth, SuiteMfaSatisfied } from '../v3/policy-probe.js';

// The controller scan takes a file's first export, so this file exports nothing else.
/** Test-only routes behind the 3.0 policies, and one that echoes the 3.0 route args. */
@BasePath(POLICY_PROBE_PATH)
export class AuthnPolicyProbeController extends BaseController {
  @Get('authenticated')
  @Policy(Authenticated)
  public authenticated() {
    return new Ok({ ok: true });
  }

  @Post('fresh')
  @Policy(SuiteFreshAuth)
  public fresh() {
    return new Ok({ ok: true });
  }

  @Post('fresh-600')
  @Policy(SuiteFreshAuth, 600)
  public fresh600() {
    return new Ok({ ok: true });
  }

  @Get('mfa')
  @Policy(SuiteMfaSatisfied)
  public mfa() {
    return new Ok({ ok: true });
  }

  @Get('no-session')
  @Policy(NoSession)
  public noSession() {
    return new Ok({ ok: true });
  }

  @Get('not-logged')
  @Policy(NotLoggedPolicy)
  public notLogged() {
    return new Ok({ ok: true });
  }

  @Get('no-token')
  @Policy(NoTokenAuthPolicy)
  public noToken() {
    return new Ok({ ok: true });
  }

  @Get('no-impersonation')
  @Policy(NoImpersonationPolicy)
  public noImpersonation() {
    return new Ok({ ok: true });
  }

  @Get('args')
  public args(@Identity() identity: AuthnIdentity | null, @AuthnSession() session: SessionHandle | null, @SessionId() sessionId: string | null, @FromSession('cart') cart: unknown) {
    return new Ok({ identity, session, sessionId, cart: cart === undefined ? '<undefined>' : cart });
  }
}
