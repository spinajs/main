import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BadRequestResponse, BaseController, BasePath, Body, Del, Get, Ok, Policy, Post } from '@spinajs/http';
import { AuthnImpersonationService } from '@spinajs/authn';
import { SessionIssuer } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';

import { ClientContext } from '../../args/authn.js';
import { AuthnImpersonationBody } from '../../dto/impersonation.js';
import { OnInvalidInput, byField, unknownField } from '../../validation/answers.js';
import { uniformFailure } from '../../validation/login.js';
import type { AuthnClientContext } from '../client.js';

import { Authenticated, ImpersonationGuardRegistered, MfaSatisfied } from '../index.js';
import { refused } from '../../policies/v3/errors.js';
import { freshAuthOrAnswer } from '../../policies/v3/fresh-auth.js';
import { isSessionPrincipal } from '../../policies/v3/principal.js';
import { narrowedBySwitch } from '../../resolvers/session.js';
import { NO_STORE, authnClearedSessionCookie, authnSessionCookie } from '../responses.js';
import { answerFor, contextOf, stampClient } from '../routes.js';

const invalidTarget = (): BadRequestResponse => new BadRequestResponse({ error: 'invalid_target', message: 'target must be a user id or { type, id }' });

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

  @Autoinject(SessionIssuer)
  protected Sessions!: SessionIssuer;

  /**
   * Impersonation state
   * `{ Active: false }`, or the impersonator, the target and the start time.
   * @returns {AuthnImpersonationState} Whether the session impersonates, and whom
   * @security cookieAuth
   */
  @Get('impersonate')
  @Policy(Authenticated)
  public async state(@ClientContext() client: AuthnClientContext) {
    const principal = client.principal!;
    const impersonator = principal.authn?.impersonator;
    if (!impersonator) return new Ok({ Active: false }, { Headers: [NO_STORE] });
    const startedAt = client.session?.impersonation?.startedAt;
    return new Ok(
      {
        Active: true,
        Impersonator: { type: impersonator.type, id: impersonator.id },
        Target: { type: principal.type, id: principal.id },
        ...(startedAt ? { StartedAt: startedAt.toISOString() } : {}),
      },
      { Headers: [NO_STORE] },
    );
  }

  /**
   * Start impersonating
   * Body `{ target, password? }`: `target` is a user id or `{ type, id }`. 400 for a malformed target (`invalid_field` for an unknown field), 401 with the login failure body when the password fails or is no string, 403 when refused.
   * @body {AuthnImpersonationBody} The target, and the password for a stale session
   * @returns {AuthnImpersonationAnswer} The principal summary of the target
   * @response 400 {AuthnError} A malformed target
   * @response 401 {AuthnUnauthorized} No session, or the inline password or code failed (the login failure body)
   * @response 403 {AuthnError} The impersonation is refused
   * @security cookieAuth
   */
  @Post('impersonate')
  @Policy([Authenticated, MfaSatisfied])
  @OnInvalidInput(byField({ target: invalidTarget, password: uniformFailure }, unknownField))
  public async start(@Body({ required: true, sensitive: ['password'] }) body: AuthnImpersonationBody, @ClientContext() client: AuthnClientContext) {
    const session = client.session;
    if (!isSessionPrincipal(client.principal!) || session?.handle.state !== 'active') throw refused('session_required', 'impersonation needs a session');
    const target: IdentityRef = typeof body.target === 'string' ? { type: 'user', id: body.target } : { type: body.target.type, id: body.target.id };

    const fresh = await freshAuthOrAnswer(this.Container, client, body.password);
    if ('answer' in fresh) return fresh.answer;
    const reauth = fresh.credentials;

    // Per call: apps that don't enable impersonation register none of its collaborators.
    const service = await this.Container.resolve(AuthnImpersonationService);
    const ctx = contextOf(client, 'request', session.handle);
    // The service checks freshness again when authn.impersonation.requirePassword is on; a stale session passed above
    // only with the password, which it then needs too.
    const started = await service.start(session.handle, target, ctx, reauth ?? undefined);
    if (!started.ok) throw refused('impersonation_refused', 'impersonation refused');
    await stampClient(this.Sessions, started.session, client);
    const principal = await service.principalOf(started.session, ctx);
    if (!principal) return new Ok({ Active: false }, { Coockies: [authnClearedSessionCookie(this._cfg)], Headers: [NO_STORE] });
    return new Ok(await answerFor(this.Container, 'impersonation', principal), { Coockies: [authnSessionCookie(this._cfg, started.session)], Headers: [NO_STORE] });
  }

  /**
   * Stop impersonating
   * A new session for the impersonator. When the impersonator may no longer log in, the impersonation ends anyway, the
   * cookie is cleared and the answer is `{ Active: false }`. 400 when no impersonation is active.
   * @returns {AuthnImpersonationAnswer} The principal summary of the impersonator, or { Active: false }
   * @security cookieAuth
   */
  @Del('impersonate')
  @Policy(Authenticated)
  public async stop(@ClientContext() client: AuthnClientContext) {
    const session = client.session;
    if (!client.principal?.authn?.impersonator || session?.handle.state !== 'active') {
      return new BadRequestResponse({ error: 'not_impersonating', message: 'no impersonation is active' });
    }
    // Per call: apps that don't enable impersonation register none of its collaborators.
    const service = await this.Container.resolve(AuthnImpersonationService);
    const ctx = contextOf(client, 'request', session.handle);
    const back = await service.stop(session.handle, ctx);
    const sessions = this.Sessions;
    const own = back ? await service.principalOf(back, ctx) : null;
    const restored = back && own ? await sessions.restore(back.id) : null;
    if (!back || !own || !restored) {
      // principalOf revokes only past the lifetime; a status refused since stop would leave this session live.
      if (back) await sessions.revoke(back);
      return new Ok({ Active: false }, { Coockies: [authnClearedSessionCookie(this._cfg)], Headers: [NO_STORE] });
    }
    await stampClient(sessions, back, client);
    // stop gave the actor its role switch back; answer with the principal the next request resolves to.
    const narrowed = await narrowedBySwitch(this.Container, restored, own);
    return new Ok(await answerFor(this.Container, 'impersonation', narrowed), { Coockies: [authnSessionCookie(this._cfg, back)], Headers: [NO_STORE] });
  }
}
