import { Bootstrapper, Injectable } from '@spinajs/di';

// The error of a missing @spinajs/authn names it as the specifier; a failure inside an installed authn names a path instead.
const MISSING_AUTHN = /['"]@spinajs\/authn(\/[^'"]*)?['"]/;

function isMissingAuthn(err: unknown): boolean {
  const { code, message } = (err ?? {}) as { code?: unknown; message?: unknown };
  return (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') && typeof message === 'string' && MISSING_AUTHN.test(message);
}

/** Loads `@spinajs/authz-http/authn` when the optional peer `@spinajs/authn` is installed, so its session-end sink is registered. */
@Injectable(Bootstrapper)
export class AuthzHttpAuthnBootstrapper extends Bootstrapper {
  public async bootstrap(): Promise<void> {
    try {
      await import('./authn/index.js');
    } catch (err) {
      if (!isMissingAuthn(err)) throw err;
    }
  }
}
