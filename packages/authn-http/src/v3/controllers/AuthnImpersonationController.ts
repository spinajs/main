import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BadRequestResponse, BaseController, BasePath, Del, Get, Ok, Policy, Post, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { AuthnImpersonationService } from '@spinajs/authn';
import { SessionIssuer } from '@spinajs/authn/contracts';
import type { Credentials } from '@spinajs/authn/contracts';

import { Authenticated, ImpersonationGuardRegistered, MfaSatisfied, assertFreshAuth } from '../index.js';
import { isAuthnFailed, refused } from '../../policies/v3/errors.js';
import { isSessionPrincipal } from '../../policies/v3/principal.js';
import { NO_STORE, authnClearedSessionCookie, authnFailureResponse, authnSessionCookie } from '../responses.js';
import { answerFor, bodyField, contextOf, identityRefOf, stampClient } from '../routes.js';

const TARGET_CAP = 256;

/** AuthnImpersonationService's session data key of the impersonation block (IMPERSONATION_BLOCK in @spinajs/authn). */
const IMPERSONATION_BLOCK = 'Impersonation';

/**
 * Impersonation over AuthnImpersonationService (A20, design §22.14). Off (404) while no ImpersonationGuard is
 * registered. Start needs an MFA-satisfied session and fresh authentication (a recent login, or the password in the
 * body through the throttled re-authentication); the service then asks the guard and its own rules. The service tells
 * no reason for a refusal, so every refusal is 403 `impersonation_refused`. Start and stop each issue a new session.
 * @tags Impersonation
 */
@BasePath('auth')
@Policy(ImpersonationGuardRegistered)
export class AuthnImpersonationController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  /**
   * Impersonation state
   * `{ Active: false }`, or the impersonator, the target and the start time.
   * @security cookieAuth
   */
  @Get('impersonate')
  @Policy(Authenticated)
  public async state(@Req() req: Request) {
    const principal = req.storage.AuthnPrincipal!;
    const impersonator = principal.authn?.impersonator;
    if (!impersonator) return new Ok({ Active: false }, { Headers: [NO_STORE] });
    const block = req.storage.AuthnSession?.data.get(IMPERSONATION_BLOCK) as { startedAt?: unknown } | undefined;
    return new Ok(
      {
        Active: true,
        Impersonator: { type: impersonator.type, id: impersonator.id },
        Target: { type: principal.type, id: principal.id },
        ...(typeof block?.startedAt === 'string' ? { StartedAt: block.startedAt } : {}),
      },
      { Headers: [NO_STORE] },
    );
  }

  /**
   * Start impersonating
   * Body `{ target, password? }`: `target` is a user id or `{ type, id }` (the 2.x `TargetUuid` and `Password` names
   * work too). 400 for a malformed target, 401 with the login failure body when the password fails, 403 when refused.
   * @security cookieAuth
   */
  @Post('impersonate')
  @Policy([Authenticated, MfaSatisfied])
  public async start(@Req() req: Request) {
    const session = req.storage.AuthnSession;
    if (!isSessionPrincipal(req.storage.AuthnPrincipal!) || session?.handle.state !== 'active') throw refused('session_required', 'impersonation needs a session');
    const target = identityRefOf(bodyField(req, 'target', 'TargetUuid'), TARGET_CAP);
    if (!target) return new BadRequestResponse({ error: 'invalid_target', message: 'target must be a user id or { type, id }' });

    let reauth: Credentials | null;
    try {
      reauth = await assertFreshAuth(this.Container, req, undefined, bodyField(req, 'password', 'Password'));
    } catch (err) {
      if (isAuthnFailed(err)) return authnFailureResponse();
      throw err;
    }

    const service = await this.Container.resolve(AuthnImpersonationService);
    const ctx = contextOf(req, 'request', session.handle);
    // The service checks freshness again when authn.impersonation.requirePassword is on; a stale session passed above
    // only with the password, which it then needs too.
    const started = await service.start(session.handle, target, ctx, reauth ?? undefined);
    if (!started.ok) throw refused('impersonation_refused', 'impersonation refused');
    await stampClient(await this.Container.resolve(SessionIssuer), started.session, req);
    const principal = await service.principalOf(started.session, ctx);
    if (!principal) return new Ok({ Active: false }, { Coockies: [authnClearedSessionCookie(this._cfg)], Headers: [NO_STORE] });
    return new Ok(await answerFor(this.Container, 'impersonation', principal), { Coockies: [authnSessionCookie(this._cfg, started.session)], Headers: [NO_STORE] });
  }

  /**
   * Stop impersonating
   * A new session for the impersonator. When the impersonator may no longer log in, the impersonation ends anyway, the
   * cookie is cleared and the answer is `{ Active: false }`. 400 when no impersonation is active.
   * @security cookieAuth
   */
  @Del('impersonate')
  @Policy(Authenticated)
  public async stop(@Req() req: Request) {
    const session = req.storage.AuthnSession;
    if (!req.storage.AuthnPrincipal?.authn?.impersonator || session?.handle.state !== 'active') {
      return new BadRequestResponse({ error: 'not_impersonating', message: 'no impersonation is active' });
    }
    const service = await this.Container.resolve(AuthnImpersonationService);
    const ctx = contextOf(req, 'request', session.handle);
    const back = await service.stop(session.handle, ctx);
    const sessions = await this.Container.resolve(SessionIssuer);
    const own = back ? await service.principalOf(back, ctx) : null;
    if (!back || !own) {
      // principalOf revokes only past the lifetime; a status refused since stop would leave this session live.
      if (back) await sessions.revoke(back);
      return new Ok({ Active: false }, { Coockies: [authnClearedSessionCookie(this._cfg)], Headers: [NO_STORE] });
    }
    await stampClient(sessions, back, req);
    return new Ok(await answerFor(this.Container, 'impersonation', own), { Coockies: [authnSessionCookie(this._cfg, back)], Headers: [NO_STORE] });
  }
}
