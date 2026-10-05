import { Autoinject, Container, NewInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { BasePolicy } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';
import { AuthnService, IdentityStore } from '@spinajs/authn/contracts';
import type { AuthnContext, Credentials, IdentityRef } from '@spinajs/authn/contracts';

import { publishAuthnEvent } from './audit.js';
import { authnFailed, refused } from './errors.js';
import { authenticatedPrincipal, isSessionPrincipal } from './principal.js';

/** The body field of an inline re-authentication on a FreshAuth route. */
export const REAUTH_PASSWORD_FIELD = 'reauthPassword';

/** authn-local's hard cap (N3): a longer value never verifies, so no strategy has to hash it. The login routes cap their fields at it too. */
export const PASSWORD_HARD_CAP = 1024;

/** The credentials to verify, or why there are none (an audit reason). */
async function passwordCredentials(container: IContainer, identity: IdentityRef, password: string): Promise<Credentials | 'password_too_long' | 'no_login'> {
  if (password.length > PASSWORD_HARD_CAP) return 'password_too_long';
  // The principal carries no login. IdentityStore.findByLogin takes an email, so display's email is one; reauthenticate
  // still refuses a password whose identity is not the session's.
  const { email } = await (await container.resolve(IdentityStore)).display(identity);
  return typeof email === 'string' && email !== '' ? { kind: 'password', login: email, password } : 'no_login';
}

/**
 * Fresh authentication for this request (A13): the session principal authenticated within `maxAgeSeconds` (default
 * authn.freshAuth.maxAgeSeconds), or `password` re-authenticates its identity with purpose 'reauth', counted in the reauth
 * throttle (SR-20). 401 without a principal, or after a failed or throttled re-authentication (the A02 body, no retry
 * information); 403 for a per-request principal, an impersonation (never fresh) or a stale session without a password.
 * Routes that take the password in their own body (role switch, impersonation) call it with that password. Answers the
 * credentials it verified, or null when the session was fresh without them.
 */
export async function assertFreshAuth(container: IContainer, req: Request, maxAgeSeconds?: number, password?: unknown): Promise<Credentials | null> {
  const principal = authenticatedPrincipal(req);
  const authn = principal.authn;
  const session = req.storage.AuthnSession;
  if (!authn || !isSessionPrincipal(principal) || session?.handle.state !== 'active') throw refused('session_required', 'fresh authentication needs a session');
  if (authn.impersonator !== undefined) throw refused('impersonating', 'no fresh authentication while impersonating another user');

  const { FreshAuthCheck, isFresh } = await import('@spinajs/authn');
  const check = await container.resolve(FreshAuthCheck);
  const maxAge = maxAgeSeconds ?? check.maxAgeSeconds;
  const ctx: AuthnContext = { ip: req.storage.ClientIp, userAgent: req.headers['user-agent'], now: new Date(), purpose: 'reauth', session: session.handle };
  if (isFresh(authn, ctx.now, maxAge)) return null;

  if (typeof password !== 'string' || password === '') throw refused('fresh_auth_required', 'this route needs a recent login or the password');
  const credentials = await passwordCredentials(container, session.identity, password);
  if (typeof credentials === 'string') {
    // Core never sees these attempts, so it cannot audit them; no_login is a store defect that looks like a wrong password.
    const { sessionHandle } = session.facts;
    await publishAuthnEvent(container, req, { type: 'reauth', outcome: 'failure', reason: credentials, identity: { type: session.identity.type, id: session.identity.id }, ...(sessionHandle ? { session: sessionHandle } : {}) });
    throw authnFailed();
  }
  // FreshAuthCheck.check passes a session that is fresh under its own, longer maxAge without verifying the password; a
  // stricter route age therefore verifies through the core re-authentication itself.
  const ok = maxAge >= check.maxAgeSeconds ? await check.check(session.handle, ctx, credentials) : await (await container.resolve(AuthnService)).reauthenticate(session.handle, credentials, ctx);
  if (!ok) throw authnFailed();
  return credentials;
}

/**
 * Passes for a session principal (principal.authn.sessionHandle is set) whose authn.authenticatedAt is at most maxAgeSeconds old,
 * or after an inline re-authentication in the same request (body field `reauthPassword`) through
 * AuthnService.reauthenticate(session, credentials, ctx) with purpose 'reauth' (A13, SR-20). Undefined maxAgeSeconds means
 * authn.freshAuth.maxAgeSeconds. Any other principal fails. `@Policy(FreshAuth, 600)` passes 600 to the constructor.
 */
@NewInstance()
export class FreshAuth extends BasePolicy {
  @Autoinject(Container)
  protected Container!: IContainer;

  constructor(public readonly maxAgeSeconds?: number) {
    super();
    if (maxAgeSeconds !== undefined && !(Number.isInteger(maxAgeSeconds) && maxAgeSeconds >= 1)) {
      throw new InvalidArgument('FreshAuth: maxAgeSeconds must be a positive integer');
    }
  }

  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(req: Request, _action: IRoute, _instance: IController): Promise<void> {
    const body: unknown = req.body;
    let password: unknown;
    if (typeof body === 'object' && body !== null) {
      password = (body as Record<string, unknown>)[REAUTH_PASSWORD_FIELD];
      // The route behind the policy must not get the account password: a body-to-model copy or a request log could keep it.
      delete (body as Record<string, unknown>)[REAUTH_PASSWORD_FIELD];
    }
    await assertFreshAuth(this.Container, req, this.maxAgeSeconds, password);
  }
}
