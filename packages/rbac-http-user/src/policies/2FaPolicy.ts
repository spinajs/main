import { Config } from '@spinajs/configuration';
import { BasePolicy, Request as sRequest } from '@spinajs/http';
import { TwoFactorAuthConfig } from '@spinajs/rbac-http';
import { Forbidden, InvalidOperation } from '@spinajs/exceptions';

/**
 * Guards routes that only make sense when 2FA is switched on system-wide.
 *
 * This is the whole check for self-service routes: an already authorized user
 * managing their own TOTP device has no pending 2FA step to look at. The
 * login-window routes need more — see {@link TwoFacRouteEnabled}.
 */
export class TwoFactorAuthEnabled extends BasePolicy {
  @Config('rbac.twoFactorAuth')
  protected TwoFactorConfig: TwoFactorAuthConfig;

  public isEnabled(): boolean {
    return true;
  }

  public async execute(_req: sRequest): Promise<void> {
    if (this.TwoFactorConfig.enabled === false) {
      // Deliberately Forbidden and not InvalidOperation: the latter has no
      // @HandleException mapping in @spinajs/http and reaches the client as a
      // 500, which a caller cannot distinguish from a fault.
      //
      // `Forbidden`'s constructor only accepts a message string (see
      // `Exception` in @spinajs/exceptions), so the structured payload that
      // the HTTP error handler serializes into the response body is attached
      // as an extra `error` property after construction.
      //
      // This method must stay `async`: `createPolicyGate` (see
      // packages/http/src/route-builder.ts) builds its wait list with
      // `enabledPolicies.map(p => p.execute(...).then(...))`. A synchronous
      // `throw` here would escape that `.map()` call entirely instead of
      // becoming a rejected promise in the array, so `Promise.allSettled`
      // would never even run — the whole policy gate blows up for every
      // caller, authorized or not, instead of just this policy losing the
      // race. Marking the method `async` turns the throw into a promise
      // rejection, which is what the gate is built to handle.
      throw Object.assign(new Forbidden('2 factor auth is not enabled'), {
        error: {
          code: 'E_2FA_SYSTEM_DISABLED',
          message: '2 factor auth is not enabled',
        },
      });
    }
  }
}

/**
 * Guards the routes that belong to the login-time 2FA step: the caller has
 * passed password authentication and the session is parked awaiting TOTP
 * verification.
 *
 * Combined with `NotAuthorizedPolicy` this window is deliberately narrow. It is
 * NOT the right guard for managing a TOTP device — a session sitting in this
 * window has not proven possession of the second factor yet, so anything it can
 * reach must not be able to weaken 2FA.
 */
export class TwoFacRouteEnabled extends TwoFactorAuthEnabled {
  public async execute(req: sRequest): Promise<void> {
    await super.execute(req);

    if (!req.storage || !req.storage.Session) {
      throw new InvalidOperation('Session is not set');
    }

    /**
     * Check only if user passed login page and waiting for TwoFactorAuth
     */
    if (!req.storage.Session?.Data.get('TwoFactorAuth')) {
      throw new Forbidden('user does not have 2fa enabled');
    }

    return Promise.resolve();
  }
}
