import { Config } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Get, Ok, Post, Req } from '@spinajs/http';
import type { ICookie, Request } from '@spinajs/http';
import { AuthnService, SessionIssuer } from '@spinajs/authn/contracts';

import { unauthenticated } from '../../policies/v3/errors.js';
import { PASSWORD_HARD_CAP } from '../../policies/v3/fresh-auth.js';
import { NO_STORE, authnClearedSessionCookie, authnFailureResponse, authnSessionCookie } from '../responses.js';
import { answerFor, auditEnded, bodyField, boundedString, contextOf, pendingSteps, stampClient } from '../routes.js';

// The 3.0 controllers are scanned only when an app lists src/v3/controllers (N8c); this file must not load the
// @spinajs/authn root at module load either.

/**
 * Login, logout and whoami of the 3.0 layer (design §22.4, §22.11). Every failed login answers the same 401 body
 * (A02); a pending (pre-MFA) session answers only `MfaRequired` (SR-07).
 * @tags Authentication
 */
@BasePath('auth')
export class AuthnLoginController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Config('authn.mfa.policy.service')
  protected MfaPolicyService: string;

  /**
   * Login
   * Body `{ login, password }` (the 2.x `Email` and `Password` names work too). Ends a session the caller already
   * holds. Success: the session cookie and the principal summary with the login extensions. MFA required: 200
   * `{ MfaRequired: [steps] }` with the pending session cookie. Any failure: 401 with one body, plus Retry-After when
   * throttled.
   * @security []
   */
  @Post('login')
  public async login(@Req() req: Request) {
    const sessions = await this.Container.resolve(SessionIssuer);
    const held = req.storage.AuthnSession;
    if (held) {
      await sessions.revoke(held.handle);
      await auditEnded(this.Container, req, held, 'session.revoke', 'login');
    }
    const cleared: ICookie[] = held ? [authnClearedSessionCookie(this._cfg)] : [];

    // Over-long values never verify (N3), so they reach no strategy, no throttle and no log.
    const login = boundedString(bodyField(req, 'login', 'Email'), PASSWORD_HARD_CAP);
    const password = boundedString(bodyField(req, 'password', 'Password'), PASSWORD_HARD_CAP);
    if (login === null || password === null) return authnFailureResponse(undefined, cleared);

    const authn = await this.Container.resolve(AuthnService);
    const result = await authn.authenticate({ kind: 'password', login, password }, contextOf(req, 'login'));
    if (result.status === 'failure') return authnFailureResponse(result.reason === 'throttled' ? result.retryAfterSeconds : undefined, cleared);
    if (result.status === 'mfa_required') {
      await stampClient(sessions, result.pending, req);
      return new Ok({ MfaRequired: [...result.steps] }, { Coockies: [authnSessionCookie(this._cfg, result.pending)], Headers: [NO_STORE] });
    }
    // A strategy that takes passwords but issues no session cannot log anyone in here.
    if (!result.session) return authnFailureResponse(undefined, cleared);
    await stampClient(sessions, result.session, req);
    const principal = await authn.principalOf(result);
    return new Ok(await answerFor(this.Container, 'login', principal), { Coockies: [authnSessionCookie(this._cfg, result.session)], Headers: [NO_STORE] });
  }

  /**
   * Logout
   * Ends the session of the cookie, pending ones included (an impersonation ends with it), and clears the cookie and
   * the site data. Audited as `logout`, and as `impersonation.end` (reason `logout`) for an impersonation (A20, A21).
   * POST, so no cross-site link can log anyone out.
   * @security cookieAuth
   * @response 401 No session
   */
  @Post('logout')
  public async logout(@Req() req: Request) {
    const session = req.storage.AuthnSession;
    if (!session) throw unauthenticated('there is no session to end');
    await (await this.Container.resolve(SessionIssuer)).revoke(session.handle);
    await auditEnded(this.Container, req, session, 'logout', 'logout');
    return new Ok(null, {
      Coockies: [authnClearedSessionCookie(this._cfg)],
      Headers: [{ Name: 'Clear-Site-Data', Value: '"cache", "cookies", "storage"' }, NO_STORE],
    });
  }

  /**
   * Who am I
   * The principal summary with the whoami extensions. A pending session gets only `{ MfaRequired: [steps] }`.
   * @security cookieAuth
   * @response 401 No principal and no pending session
   */
  @Get('/')
  public async whoami(@Req() req: Request) {
    const principal = req.storage.AuthnPrincipal;
    if (principal?.authenticated === true) return new Ok(await answerFor(this.Container, 'whoami', principal), { Headers: [NO_STORE] });
    const session = req.storage.AuthnSession;
    if (session?.handle.state === 'pending') return new Ok({ MfaRequired: await pendingSteps(this.Container, session, this.MfaPolicyService) }, { Headers: [NO_STORE] });
    throw unauthenticated('this route needs an authenticated caller');
  }
}
