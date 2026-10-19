import { createHash } from 'node:crypto';
import * as cs from 'cookie-signature';
import type { Log } from '@spinajs/log';

// The session cookie as AuthnMiddleware and the socket session source read it.

// Domain-separated and cut short: sha256 of a raw session id is its storage key, which must not reach a log.
export const logHash = (value: string): string => createHash('sha256').update(`authn-http:log\0${value}`).digest('hex').slice(0, 16);

/** The session id of a cookie value that `cs.sign` signed with `secret`; false for a bad signature. */
export const unsignSessionCookie = (value: string, secret: string): string | false => cs.unsign(value, secret);

export function warnNoLiveSession(log: Log, id: string, ip: unknown): void {
  log.warn({ session: logHash(id), ip }, 'Session cookie names no live session (expired or unknown): session ${session}, ip ${ip}');
}
