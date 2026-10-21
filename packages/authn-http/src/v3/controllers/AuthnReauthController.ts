import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BaseController, BasePath, Body, Ok, Policy, Post } from '@spinajs/http';
import type { Unauthorized } from '@spinajs/http';
import { AuthnService, SessionIssuer } from '@spinajs/authn/contracts';

import { ClientContext } from '../../args/authn.js';
import { AuthnReauthBody } from '../../dto/reauth.js';
import { refused, unauthenticated } from '../../policies/v3/errors.js';
import { reauthCredentials } from '../../policies/v3/fresh-auth.js';
import { ActiveSessionOnly } from '../../policies/v3/session-state.js';
import { OnInvalidInput } from '../../validation/answers.js';
import { uniformFailure } from '../../validation/login.js';
import type { AuthnClientContext } from '../client.js';
import { NO_STORE, authnFailureResponse, authnSessionCookie } from '../responses.js';
import { answerFor, contextOf, onLiveSession } from '../routes.js';

/**
 * Fresh authentication that lasts (A13): the password re-authenticates the active session, which then moves to a new
 * id with `authenticatedAt` set to now, so FreshAuth routes pass without `reauthPassword` for
 * authn.freshAuth.maxAgeSeconds. The inline `reauthPassword` of a FreshAuth route still counts for that request only.
 * @tags Authentication
 */
@BasePath('auth')
export class AuthnReauthController extends BaseController {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Autoinject(SessionIssuer)
  protected Sessions!: SessionIssuer;

  /**
   * Re-authenticate the session
   * Body `{ password }`. Success: the session cookie of the new id and the principal summary. 401 with the login failure body for a wrong or throttled password (no Retry-After); 403 for a pending session or an impersonation.
   * @security cookieAuth
   */
  @Post('reauth')
  @Policy(ActiveSessionOnly)
  @OnInvalidInput(uniformFailure)
  public async reauth(@Body({ required: true }) body: AuthnReauthBody, @ClientContext() client: AuthnClientContext): Promise<Ok | Unauthorized> {
    const session = client.session;
    if (session?.handle.state !== 'active') throw unauthenticated('this route needs a session');
    if (session.facts.impersonator !== undefined) throw refused('impersonating', 'no re-authentication while impersonating another user');

    // Audits an over-long password itself; the core never sees it.
    const credentials = await reauthCredentials(this.Container, client, session, body.password);
    if (!credentials) return authnFailureResponse();

    // Per call: an eager AuthnService builds its checked neighbours, missing in apps without them.
    const authn = await this.Container.resolve(AuthnService);
    const ctx = contextOf(client, 'reauth', session.handle);
    if (!(await authn.reauthenticate(session.handle, credentials, ctx))) return authnFailureResponse();

    const sessions = this.Sessions;
    const next = await onLiveSession(() => sessions.reissue(session.handle, { authenticatedAt: ctx.now }));
    const now = await sessions.restore(next.id);
    if (!now) throw unauthenticated('the session has ended');
    const { authenticatedAt: _at, ...facts } = now.facts;
    const principal = await authn.principalOf({ status: 'success', identity: now.identity, facts, session: next });
    return new Ok(await answerFor(this.Container, 'whoami', principal), { Coockies: [authnSessionCookie(this._cfg, next)], Headers: [NO_STORE] });
  }
}
