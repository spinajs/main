import type { AuthnContext, AuthnFacts, Credentials, IAuthnPrincipalStorage, IdentityRef, Principal, SessionIssuer } from '@spinajs/authn/contracts';
import { BasePolicy, ServerMiddleware } from '@spinajs/http';
import type { IController, IRoute, Request, Route } from '@spinajs/http';
import type * as express from 'express';

declare module '@spinajs/http' {
  interface IActionLocalStoregeContext extends IAuthnPrincipalStorage {
    /** Written by ClientIp: the client address from the trusted-proxy chain only (A05). Authn reads this, never realIp. */
    ClientIp?: string;
    /**
     * Written by AuthnMiddleware: the restored session, pending included; null without one. The session route args read it.
     * A session here is not authentication: check handle.state; only AuthnPrincipal means authenticated (SR-07).
     */
    AuthnSession?: NonNullable<Awaited<ReturnType<SessionIssuer['restore']>>> | null;
  }
}

// Takes the stub's arguments so the frozen parameter names need no `_` prefix under noUnusedParameters.
function notImplemented(member: string, ..._args: unknown[]): never {
  throw new Error(`not implemented: ${member}`);
}

/** Passes when an authn principal exists; a pending (pre-MFA) session yields none and fails (D25, SR-07). Replaces LoggedPolicy and AuthorizedPolicy. */
export class Authenticated extends BasePolicy {
  public isEnabled(action: IRoute, instance: IController): boolean {
    return notImplemented('Authenticated.isEnabled', action, instance);
  }

  public execute(req: Request, action: IRoute, instance: IController): Promise<void> {
    return notImplemented('Authenticated.execute', req, action, instance);
  }
}

/**
 * Passes for a session principal (principal.authn.sessionHandle is set) whose authn.authenticatedAt is at most maxAgeSeconds old,
 * or after an inline re-authentication in the same request through AuthnService.reauthenticate(session, credentials, ctx) with
 * purpose 'reauth', so failures count into the reauth throttle (A13, SR-20). Undefined maxAgeSeconds means
 * authn.freshAuth.maxAgeSeconds, read when the policy runs. Any other principal fails: a per-request credential would always look fresh.
 * Body-dependent cases (a switch to a requirePassword role, impersonation with authn.impersonation.requirePassword) run the same
 * check in the controller through a module-private helper. `@Policy(FreshAuth, 600)` passes 600 to the constructor.
 */
export class FreshAuth extends BasePolicy {
  constructor(public readonly maxAgeSeconds?: number) {
    super();
  }

  public isEnabled(action: IRoute, instance: IController): boolean {
    return notImplemented('FreshAuth.isEnabled', action, instance);
  }

  public execute(req: Request, action: IRoute, instance: IController): Promise<void> {
    return notImplemented('FreshAuth.execute', req, action, instance);
  }
}

/** Passes when MfaPolicy requires no step for the principal, or its authn.assurance is aal2 (A20). */
export class MfaSatisfied extends BasePolicy {
  public isEnabled(action: IRoute, instance: IController): boolean {
    return notImplemented('MfaSatisfied.isEnabled', action, instance);
  }

  public execute(req: Request, action: IRoute, instance: IController): Promise<void> {
    return notImplemented('MfaSatisfied.execute', req, action, instance);
  }
}

/** Passes only when the request restored no session, active or pending. */
export class NoSession extends BasePolicy {
  public isEnabled(action: IRoute, instance: IController): boolean {
    return notImplemented('NoSession.isEnabled', action, instance);
  }

  public execute(req: Request, action: IRoute, instance: IController): Promise<void> {
    return notImplemented('NoSession.execute', req, action, instance);
  }
}

/** Passes only without an authn principal; a pending session passes, so a half-finished login can start over. */
export class NotLoggedPolicy extends BasePolicy {
  public isEnabled(action: IRoute, instance: IController): boolean {
    return notImplemented('NotLoggedPolicy.isEnabled', action, instance);
  }

  public execute(req: Request, action: IRoute, instance: IController): Promise<void> {
    return notImplemented('NotLoggedPolicy.execute', req, action, instance);
  }
}

/** Fails when the authn principal came from a per-request credential (API token, JWT, key or signature): no credential mints or manages credentials. */
export class NoTokenAuthPolicy extends BasePolicy {
  public isEnabled(action: IRoute, instance: IController): boolean {
    return notImplemented('NoTokenAuthPolicy.isEnabled', action, instance);
  }

  public execute(req: Request, action: IRoute, instance: IController): Promise<void> {
    return notImplemented('NoTokenAuthPolicy.execute', req, action, instance);
  }
}

/** Fails while impersonating (principal.authn.impersonator is set): routes that hand out lasting credentials need the account owner. */
export class NoImpersonationPolicy extends BasePolicy {
  public isEnabled(action: IRoute, instance: IController): boolean {
    return notImplemented('NoImpersonationPolicy.isEnabled', action, instance);
  }

  public execute(req: Request, action: IRoute, instance: IController): Promise<void> {
    return notImplemented('NoImpersonationPolicy.execute', req, action, instance);
  }
}

/** What `@Identity()` resolves to. `identity` is the principal's own type and id (for an agent, the agent, not onBehalfOf). */
export interface AuthnIdentity {
  readonly identity: IdentityRef;
  readonly facts: AuthnFacts;
}

/** Resolves to the AuthnIdentity of req.storage.AuthnPrincipal, or null without a principal (a pending session gives null). */
export function Identity(): ReturnType<typeof Route> {
  return notImplemented('Identity');
}

/** Resolves to the SessionHandle of req.storage.AuthnSession, pending included (the MFA routes need it), or null. Not authentication: check handle.state. */
export function AuthnSession(): ReturnType<typeof Route> {
  return notImplemented('AuthnSession');
}

/**
 * Resolves to the raw id of the restored session (pending included, so not authentication), or null; an unknown or expired cookie
 * gives null. Never log or return it.
 */
export function SessionId(): ReturnType<typeof Route> {
  return notImplemented('SessionId');
}

/**
 * Resolves to the value stored under `key` in the restored session's data (SessionIssuer.set), or undefined without a session or key.
 * Pending sessions included, so not authentication.
 */
export function FromSession(key: string): ReturnType<typeof Route> {
  return notImplemented('FromSession', key);
}

/**
 * Order 1. Writes req.storage.ClientIp: the socket address, or the client address behind trusted proxy hops only
 * (authn.http.trustProxy, else http.trustProxy; none ⇒ the socket address) (A05).
 */
export class ClientIp extends ServerMiddleware {
  constructor() {
    super();
    this.Order = 1;
  }

  public before(): ((req: Request, res: express.Response, next: express.NextFunction) => void) | null {
    return notImplemented('ClientIp.before');
  }

  public after(): ((req: Request, res: express.Response, next: express.NextFunction) => void) | express.ErrorRequestHandler | null {
    return notImplemented('ClientIp.after');
  }
}

/**
 * Order 4, before AuthnMiddleware; off when authn.http.csrf.enabled is false. An unsafe method carrying the session cookie passes only
 * when Origin (or, without it, Sec-Fetch-Site: same-origin) is the app's own origin or in authn.http.csrf.allowedOrigins; else 403
 * before any controller (A22, SR-12). A22 exempts requests without the session cookie (token, key, signature); the guard may still
 * check the routes that issue a session (login CSRF).
 */
export class CsrfOriginGuard extends ServerMiddleware {
  constructor() {
    super();
    this.Order = 4;
  }

  public before(): ((req: Request, res: express.Response, next: express.NextFunction) => void) | null {
    return notImplemented('CsrfOriginGuard.before');
  }

  public after(): ((req: Request, res: express.Response, next: express.NextFunction) => void) | express.ErrorRequestHandler | null {
    return notImplemented('CsrfOriginGuard.after');
  }
}

/**
 * Order 5, after ClientIp and CsrfOriginGuard and every http built-in (≤ 3); authz-http's PrincipalMiddleware must come later.
 * Restores the session cookie into req.storage.AuthnSession. Without an active session it takes the first CredentialExtractor answer
 * (an active session ignores bearer credentials), asks the AuthnPrincipalResolvers in ascending order and writes the first answer
 * that is not undefined, else null, to req.storage.AuthnPrincipal (D26).
 */
export class AuthnMiddleware extends ServerMiddleware {
  constructor() {
    super();
    this.Order = 5;
  }

  public before(): ((req: Request, res: express.Response, next: express.NextFunction) => void) | null {
    return notImplemented('AuthnMiddleware.before');
  }

  public after(): ((req: Request, res: express.Response, next: express.NextFunction) => void) | express.ErrorRequestHandler | null {
    return notImplemented('AuthnMiddleware.after');
  }
}

/**
 * One credential family in AuthnMiddleware's principal resolution. Registered with Array.ofType, asked in ascending `order`.
 * undefined: none of this resolver's credentials, ask the next. null: its credentials are present but yield no principal (rejected,
 * expired, revoked, or a pending session); resolution stops, so a bad credential never falls through to another one.
 * Never throws for bad credentials. Key and token resolvers verify through AuthnService.authenticate(credentials, ctx) with purpose
 * 'request', then AuthnService.principalOf (PrincipalFactory, authn facts, A23), so the throttle and audit apply (A05, A21); never
 * through TokenService or KeyRegistry directly.
 */
export abstract class AuthnPrincipalResolver {
  /** Lower is asked first. */
  abstract readonly order: number;
  /** `credentials` is passed, never stored on the request, because it holds secrets; `ctx.ip` comes from ClientIp (A05). */
  abstract resolve(req: Request, credentials: Credentials | null, ctx: AuthnContext): Promise<Principal | null | undefined>;
}

/** Order 45: jws-assertion and http-signature credentials. The key owner (user, service or agent per the key record) with the key's scope as ceiling (§22.10). */
export class KeyPrincipalResolver extends AuthnPrincipalResolver {
  public readonly order: number = 45;

  public resolve(req: Request, credentials: Credentials | null, ctx: AuthnContext): Promise<Principal | null | undefined> {
    return notImplemented('KeyPrincipalResolver.resolve', req, credentials, ctx);
  }
}

/**
 * Order 50: bearer credentials. An spt_ token gives its owner with ceiling.roles = the token's roles plus its Scope ceiling;
 * Scope.agent gives an agent principal, onBehalfOf the owner, delegation 'inherit', ceiling reason 'out_of_scope' (A15).
 * A JWT gives the linked user (§22.9).
 */
export class TokenPrincipalResolver extends AuthnPrincipalResolver {
  public readonly order: number = 50;

  public resolve(req: Request, credentials: Credentials | null, ctx: AuthnContext): Promise<Principal | null | undefined> {
    return notImplemented('TokenPrincipalResolver.resolve', req, credentials, ctx);
  }
}

/**
 * Order 100: req.storage.AuthnSession. Pending ⇒ null (D25, A09). Otherwise the session's user with its authn facts,
 * and ceiling.roles = [ActiveRole] after a role switch (D14).
 */
export class SessionPrincipalResolver extends AuthnPrincipalResolver {
  public readonly order: number = 100;

  public resolve(req: Request, credentials: Credentials | null, ctx: AuthnContext): Promise<Principal | null | undefined> {
    return notImplemented('SessionPrincipalResolver.resolve', req, credentials, ctx);
  }
}
