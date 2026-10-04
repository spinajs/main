import { DateTime } from 'luxon';
import { DI } from '@spinajs/di';
import { normalizeEnvironment } from '@spinajs/configuration-common';
import type { Configuration } from '@spinajs/configuration-common';
import { InvalidOption } from '@spinajs/exceptions';
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

/** `'auto'` (the default) is on unless the app env is development or test. */
export type SessionCookieFlag = boolean | 'auto' | 'true' | 'false';

/**
 * `authn.session.cookie`. Unknown keys pass through to express (`domain`,
 * `path`, `priority`, …). `httpOnly` and `signed` are not tunable.
 */
export interface ISessionCookieConfig {
  /** Base cookie name. Default `ssid`. */
  name?: string;

  /** Emit `__Host-<name>`; forces `Secure`, `Path=/` and no `Domain`, which browsers require for the prefix. */
  hostPrefix?: SessionCookieFlag;

  secure?: SessionCookieFlag;

  /** Default `strict`. */
  sameSite?: 'strict' | 'lax' | 'none' | boolean;

  [key: string]: unknown;
}

/** Keys consumed here rather than handed to express. */
const COOKIE_CONTROL_KEYS = ['name', 'hostPrefix'];

/** Shipped in `@spinajs/http`'s default config, so anyone can forge signatures made with it. */
export const PUBLIC_DEFAULT_COOKIE_SECRET = '1234adreewD';

/** Only these envs relax the cookie; an absent or unknown env is treated as production. */
function isRelaxedEnv(env: string | undefined): boolean {
  const normalized = normalizeEnvironment(env);
  return normalized === 'dev' || normalized === 'test';
}

function flagOn(flag: SessionCookieFlag | undefined, env: string | undefined): boolean {
  if (flag === undefined || flag === 'auto') {
    return !isRelaxedEnv(env);
  }
  return flag !== false && flag !== 'false';
}

const given = (v: unknown): boolean => typeof v === 'string' && v !== '';

/**
 * The app env as the configuration resolved it from `--env`, `APP_ENV` or `NODE_ENV`; undefined when none was set
 * and the configuration fell back to development, so the cookie gets the production flags (SR-16).
 */
export function appEnvOf(config: Configuration): string | undefined {
  const env = config.get<string | undefined>('process.env.APP_ENV');
  // The condition of authnEnvFellBack (@spinajs/authn, test-pinned): importing that root entry would register its services.
  const registered = DI.get<NodeJS.ProcessEnv>('process.env');
  const fellBack = !given((config as { Env?: unknown }).Env) && !given(registered?.APP_ENV) && !given(process.env.APP_ENV) && !given(process.env.NODE_ENV) && env === 'development';
  return fellBack ? undefined : env;
}

/**
 * Throws when the cookie signing secret is missing, or is the public default
 * outside development and test.
 *
 * @param env - app env, see {@link appEnvOf}; absent means production
 */
export function assertSessionCookieSecret(secret: string | undefined, env?: string): void {
  if (!secret) {
    throw new InvalidOption('http.cookie.secret is not set; session cookies cannot be signed');
  }
  if (secret === PUBLIC_DEFAULT_COOKIE_SECRET && !isRelaxedEnv(env)) {
    throw new InvalidOption('http.cookie.secret is the public default shipped with @spinajs/http; set a secret of your own');
  }
}

/** @param env - app env, see {@link appEnvOf}; absent means production */
export function sessionCookieName(config: ISessionCookieConfig = {}, env?: string): string {
  const base = (config.name as string) ?? SESSION_COOKIE_BASE_NAME;
  return flagOn(config.hostPrefix, env) ? `__Host-${base}` : base;
}

/**
 * Cookie options for the session cookie. The configuration is spread first
 * and the security flags last, so a stray `httpOnly: false` cannot downgrade
 * the cookie.
 *
 * @param maxAge - lifetime in ms; `undefined` = browser-session cookie
 * @param env - app env, see {@link appEnvOf}; absent means production
 */
export function sessionCookieOptions(config: ISessionCookieConfig = {}, maxAge?: number, env?: string): Record<string, unknown> {
  const passthrough: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!COOKIE_CONTROL_KEYS.includes(key)) {
      passthrough[key] = value;
    }
  }

  const options: Record<string, unknown> = {
    ...passthrough,
    httpOnly: true,
    secure: flagOn(config.secure, env),
    sameSite: config.sameSite ?? 'strict',
    maxAge,
  };

  if (flagOn(config.hostPrefix, env)) {
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
 * @param env - app env, see {@link appEnvOf}; absent means production
 */
export function sessionCookie(rawId: string, config: ISessionCookieConfig = {}, expiration?: DateTime, env?: string): ISessionCookieDescriptor {
  return {
    Name: sessionCookieName(config, env),
    Value: rawId,
    Options: {
      ...sessionCookieOptions(config, cookieMaxAge(expiration), env),
      signed: true,
    },
  };
}

/**
 * An already-expired session cookie; clears the session client side on logout.
 *
 * @param env - app env, see {@link appEnvOf}; absent means production
 */
export function clearSessionCookie(config: ISessionCookieConfig = {}, env?: string): ISessionCookieDescriptor {
  return {
    Name: sessionCookieName(config, env),
    Value: '',
    Options: {
      ...sessionCookieOptions(config, 0, env),
      signed: false,
    },
  };
}
