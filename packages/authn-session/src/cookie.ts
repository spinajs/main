import { DateTime } from 'luxon';
import type { ISession } from './contracts.js';

/**
 * Cookie `maxAge` (ms) from an expiration instant: `undefined` for a
 * never-expiring session (a browser-session cookie), never negative.
 */
export function cookieMaxAge(expiration: DateTime | undefined): number | undefined {
  if (!expiration) {
    return undefined;
  }
  return Math.max(0, Math.floor(expiration.diff(DateTime.now()).milliseconds));
}

/** Cookie `maxAge` (ms) from a session's real `Expiration` (B1). */
export function sessionCookieMaxAge(session: ISession): number | undefined {
  return cookieMaxAge(session.Expiration);
}

/** Base name of the session cookie, before any `__Host-` prefix. */
export const SESSION_COOKIE_BASE_NAME = 'ssid';

/**
 * `authn.session.cookie`. Unknown keys pass through to express (`domain`,
 * `path`, `priority`, …). `httpOnly` and `signed` are not tunable.
 */
export interface ISessionCookieConfig {
  /** Base cookie name. Default `ssid`. */
  name?: string;

  /** Emit `__Host-<name>`; forces `Secure`, `Path=/` and no `Domain`, which browsers require for the prefix. */
  hostPrefix?: boolean;

  /** Default `true`. */
  secure?: boolean;

  /** Default `strict`. */
  sameSite?: 'strict' | 'lax' | 'none' | boolean;

  [key: string]: unknown;
}

/** Keys consumed here rather than handed to express. */
const COOKIE_CONTROL_KEYS = ['name', 'hostPrefix'];

export function sessionCookieName(config: ISessionCookieConfig = {}): string {
  const base = (config.name as string) ?? SESSION_COOKIE_BASE_NAME;
  return config.hostPrefix ? `__Host-${base}` : base;
}

/**
 * Cookie options for the session cookie. The configuration is spread first
 * and the security flags last, so a stray `httpOnly: false` cannot downgrade
 * the cookie.
 *
 * @param maxAge - lifetime in ms; `undefined` = browser-session cookie
 */
export function sessionCookieOptions(config: ISessionCookieConfig = {}, maxAge?: number): Record<string, unknown> {
  const passthrough: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!COOKIE_CONTROL_KEYS.includes(key)) {
      passthrough[key] = value;
    }
  }

  const options: Record<string, unknown> = {
    ...passthrough,
    httpOnly: true,
    secure: config.secure ?? true,
    sameSite: config.sameSite ?? 'strict',
    maxAge,
  };

  if (config.hostPrefix) {
    options.secure = true;
    options.path = '/';
    delete options.domain;
  }

  return options;
}

/** Session cookie in the shape the http `Coockies` response option accepts. */
export interface ISessionCookieDescriptor {
  Name: string;
  Value: string;
  Options: Record<string, unknown>;
}

/**
 * The signed session cookie. It carries the RAW id (`SessionHandle.id`); the
 * store only ever holds its hash.
 *
 * @param rawId - `SessionHandle.id`
 * @param expiration - when the session expires; `undefined` = browser-session cookie
 */
export function sessionCookie(rawId: string, config: ISessionCookieConfig = {}, expiration?: DateTime): ISessionCookieDescriptor {
  return {
    Name: sessionCookieName(config),
    Value: rawId,
    Options: {
      ...sessionCookieOptions(config, cookieMaxAge(expiration)),
      signed: true,
    },
  };
}

/** An already-expired session cookie; clears the session client side on logout. */
export function clearSessionCookie(config: ISessionCookieConfig = {}): ISessionCookieDescriptor {
  return {
    Name: sessionCookieName(config),
    Value: '',
    Options: {
      ...sessionCookieOptions(config, 0),
      signed: false,
    },
  };
}
