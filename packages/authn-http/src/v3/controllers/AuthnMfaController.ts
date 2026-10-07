import { Config } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Ok, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { AuthnService } from '@spinajs/authn/contracts';

import { refused, unauthenticated } from '../../policies/v3/errors.js';
import { PASSWORD_HARD_CAP } from '../../policies/v3/fresh-auth.js';
import { NO_STORE, authnFailureResponse, authnSessionCookie } from '../responses.js';
import { answerFor, bodyField, boundedString, contextOf, pendingSteps } from '../routes.js';

/** completeMfa's step for recovery codes (contracts: MfaStep.name, AuthnService.completeMfa). */
const RECOVERY_STEP = 'recovery';

/**
 * Completes the login of a pending (pre-MFA) session (A09, A10). Only a pending session reaches these routes: none
 * answers 401, an active one 403. Success elevates the session to aal2 under a new id, keeping its data; a failure
 * answers the login failure body and leaves the session pending.
 * @tags Authentication
 */
@BasePath('auth')
export class AuthnMfaController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Config('authn.mfa.policy.service')
  protected MfaPolicyService: string;

  /**
   * Verify an MFA step
   * Body `{ code, step? }`: `step` when it is one of the pending steps, else the first pending step.
   * @security cookieAuth
   */
  @Post('mfa/verify')
  public async verify(@Req() req: Request) {
    return this.complete(req, false);
  }

  /**
   * Use a recovery code
   * Body `{ code }`: a single-use recovery code instead of a step.
   * @security cookieAuth
   */
  @Post('mfa/recovery')
  public async recovery(@Req() req: Request) {
    return this.complete(req, true);
  }

  protected async complete(req: Request, recovery: boolean) {
    const session = req.storage.AuthnSession;
    if (!session) throw unauthenticated('this route needs a pending session');
    if (session.handle.state !== 'pending') throw refused('mfa_not_pending', 'this session needs no second factor');

    const code = boundedString(bodyField(req, 'code'), PASSWORD_HARD_CAP);
    if (code === null) return authnFailureResponse();
    let step = RECOVERY_STEP;
    if (!recovery) {
      const steps = await pendingSteps(this.Container, session, this.MfaPolicyService);
      const asked = bodyField(req, 'step');
      const chosen = typeof asked === 'string' && steps.includes(asked) ? asked : steps[0];
      if (chosen === undefined) return authnFailureResponse();
      step = chosen;
    }

    const authn = await this.Container.resolve(AuthnService);
    const result = await authn.completeMfa(session.handle, step, code, contextOf(req, 'login', session.handle));
    if (result.status === 'failure') return authnFailureResponse(result.reason === 'throttled' ? result.retryAfterSeconds : undefined);
    if (result.status !== 'success' || !result.session) return authnFailureResponse();
    const principal = await authn.principalOf(result);
    return new Ok(await answerFor(this.Container, 'mfa', principal), { Coockies: [authnSessionCookie(this._cfg, result.session)], Headers: [NO_STORE] });
  }
}
