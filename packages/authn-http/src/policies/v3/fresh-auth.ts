import { Autoinject, Container, NewInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BasePolicy } from '@spinajs/http';
import type { IController, IRoute, Request, Unauthorized } from '@spinajs/http';
import { FreshAuthCheck, isFresh } from '@spinajs/authn';
import { AuthnService, IdentityStore } from '@spinajs/authn/contracts';
import type { Credentials, Session } from '@spinajs/authn/contracts';
import { _check_arg, _gte, _integer, _is_number, isPlainObject } from '@spinajs/util';

import { contextOf } from '../../v3/context.js';
import { authnFailureResponse } from '../../v3/responses.js';
import { publishAuthnEvent } from './audit.js';
import { authnFailed, isAuthnFailed, refused } from './errors.js';
import { authenticatedPrincipal, isSessionPrincipal } from './principal.js';

/** The body field of an inline re-authentication on a FreshAuth route. */
export const REAUTH_PASSWORD_FIELD = 'reauthPassword';

/** authn-local's hard cap (N3): a longer value never verifies, so no strategy has to hash it. The login routes cap their fields at it too. */
export const PASSWORD_HARD_CAP = 1024;

/**
 * Removes the inline re-authentication from the body and returns it. The route behind must not get the account password:
 * a body-to-model copy or a request log could keep it. The raw bytes go too, not a re-serialised copy that a route
 * checking a signature would take for the client's; AuthnMiddleware read them for HTTP signatures before any policy ran.
 */
export function takeReauthPassword(req: Request): unknown {
  const body: unknown = req.body;
  if (!isPlainObject(body) || !(REAUTH_PASSWORD_FIELD in body)) return undefined;
  const password = body[REAUTH_PASSWORD_FIELD];
  delete body[REAUTH_PASSWORD_FIELD];
  delete (req as { rawBody?: unknown }).rawBody;
  return password;
}

/**
 * The password credentials of the session's identity, or null after auditing why there are none: a password over
 * PASSWORD_HARD_CAP, or an identity without a login (a store defect that looks like a wrong password). Core never sees
 * these attempts, so it cannot audit them.
 */
export async function reauthCredentials(container: IContainer, req: Request, session: Session, password: string): Promise<Credentials | null> {
  let reason = 'password_too_long';
  if (password.length <= PASSWORD_HARD_CAP) {
    // The principal carries no login. IdentityStore.findByLogin takes an email, so display's email is one; reauthenticate
    // still refuses a password whose identity is not the session's.
    const { email } = await (await container.resolve(IdentityStore)).display(session.identity);
    if (typeof email === 'string' && email !== '') return { kind: 'password', login: email, password };
    reason = 'no_login';
  }
  const { sessionHandle } = session.facts;
  await publishAuthnEvent(container, req, { type: 'reauth', outcome: 'failure', reason, identity: { type: session.identity.type, id: session.identity.id }, ...(sessionHandle ? { session: sessionHandle } : {}) });
  return null;
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

  const check = await container.resolve(FreshAuthCheck);
  const maxAge = maxAgeSeconds ?? check.maxAgeSeconds;
  const ctx = contextOf(req, 'reauth', session.handle);
  if (isFresh(authn, ctx.now, maxAge)) return null;

  if (typeof password !== 'string' || password === '') throw refused('fresh_auth_required', 'this route needs a recent login or the password');
  const credentials = await reauthCredentials(container, req, session, password);
  if (!credentials) throw authnFailed();
  // FreshAuthCheck.check passes a session that is fresh under its own, longer maxAge without verifying the password; a
  // stricter route age therefore verifies through the core re-authentication itself.
  const ok = maxAge >= check.maxAgeSeconds ? await check.check(session.handle, ctx, credentials) : await (await container.resolve(AuthnService)).reauthenticate(session.handle, credentials, ctx);
  if (!ok) throw authnFailed();
  return credentials;
}

/**
 * assertFreshAuth for a route handler, `password` taken from the body: a failed re-authentication becomes the login
 * failure answer, since the thrown error's body carries a stack outside production. In the handler, not as a FreshAuth
 * policy: http runs every policy of a route at once, so the policy would verify a password while a gate answers 404.
 */
export async function freshAuthOrAnswer(container: IContainer, req: Request, password: unknown): Promise<{ credentials: Credentials | null } | { answer: Unauthorized }> {
  try {
    return { credentials: await assertFreshAuth(container, req, undefined, password) };
  } catch (err) {
    if (isAuthnFailed(err)) return { answer: authnFailureResponse() };
    throw err;
  }
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
    if (maxAgeSeconds !== undefined) {
      _check_arg(_is_number(_integer(), _gte(1)))(maxAgeSeconds, 'maxAgeSeconds');
    }
  }

  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(req: Request, _action: IRoute, _instance: IController): Promise<void> {
    await assertFreshAuth(this.Container, req, this.maxAgeSeconds, takeReauthPassword(req));
  }
}
