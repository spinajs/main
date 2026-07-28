import type express from 'express';
import cookieParser from 'cookie-parser';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';

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
