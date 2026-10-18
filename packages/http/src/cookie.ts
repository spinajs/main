import type express from 'express';
import cookieParser from 'cookie-parser';
import { DI } from '@spinajs/di';
import { Configuration, normalizeEnvironment } from '@spinajs/configuration';
import type { ICookie } from './interfaces.js';

/** `http.cookie.secret` as the package ships it: public, so anyone can sign cookies with it. */
export const HTTP_PUBLIC_COOKIE_SECRET = '1234adreewD';

export function isPublicCookieSecret(secret: unknown): boolean {
  return secret === HTTP_PUBLIC_COOKIE_SECRET;
}

/**
 * cookie-parser bound to the configured `http.cookie.secret`.
 *
 * It MUST be constructed with the secret: that is what puts `req.secret` in place,
 * and without it express throws `cookieParser("secret") required for signed cookies`
 * from any `res.cookie(..., { signed: true })`. Logging in sets a signed `ssid`
 * cookie, so a secretless parser breaks authentication outright.
 *
 * The secret is read on FIRST REQUEST rather than when this module is evaluated,
 * because the config file that installs this middleware is itself loaded before the
 * Configuration service exists. Capturing the value at module scope would freeze the
 * shipped default and silently ignore whatever the app configured.
 */
let parser: express.RequestHandler | undefined;

export const configuredCookieParser: express.RequestHandler = (req, res, next) => {
  if (!parser) {
    const secret = DI.get(Configuration)?.get<string>('http.cookie.secret');
    parser = cookieParser(secret);
  }

  return parser(req, res, next);
};

/**
 * Drops the memoised parser. Only needed where the configured secret can change
 * within one process, ie. tests.
 */
export function resetCookieParser(): void {
  parser = undefined;
}

const isRelaxedEnv = (env: string | null | undefined): boolean => ['dev', 'test'].includes(normalizeEnvironment(env));

/**
 * A `__Host-<name>` cookie: Secure, `Path=/` and no Domain, as browsers require for the prefix. Development and test
 * (plain http on localhost) drop the prefix and Secure; an absent or unknown env is production.
 */
export function hostPrefixedCookie(name: string, value: string, options: express.CookieOptions = {}, env?: string | null): ICookie {
  const relaxed = isRelaxedEnv(env);
  // domain undefined, not deleted: it must override a domain from http.cookie.options, which responses merge in first.
  return { Name: relaxed ? name : `__Host-${name}`, Value: value, Options: { ...options, secure: !relaxed, path: '/', domain: undefined } };
}

/** The expired, unsigned copy of `cookie` that clears it in the browser. */
export function clearCookie(cookie: ICookie): ICookie {
  return { Name: cookie.Name, Value: '', Options: { ...cookie.Options, maxAge: 0, signed: false } };
}
