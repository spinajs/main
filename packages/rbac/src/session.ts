import { DateTime } from 'luxon';
import { createHash } from 'crypto';
import { SessionProvider, ISession } from './interfaces.js';
import { Injectable, NewInstance } from '@spinajs/di';
import { v4 as uuidv4 } from 'uuid';

/**
 * Session base class
 */
@NewInstance()
export class UserSession implements ISession {
  public SessionId: string = uuidv4();

  /**
   * User id that owns this session. Single source of truth for ownership.
   */
  public UserId: number;

  public Creation: DateTime = DateTime.now();

  /**
   * Expiration time for session, if undefined it does not expire.
   * Set by the SessionProvider through the configured expiration strategy.
   */
  public Expiration: DateTime | undefined = undefined;

  public Data: Map<string, unknown> = new Map();

  constructor(session?: Partial<ISession>) {
    if (session) {
      Object.assign(this, session);
    }
  }
}

/**
 * Derives the `ssid` cookie `maxAge` (milliseconds) from a session's real
 * `Expiration` (fixes B1 — the cookie previously always died at
 * `expiration * 1000` ms i.e. ~2 minutes). Returns `undefined` for a
 * never-expiring session (a session cookie), and never a negative value.
 *
 * @param session - the session whose expiry drives the cookie lifetime
 */
export function sessionCookieMaxAge(session: ISession): number | undefined {
  if (!session.Expiration) {
    return undefined;
  }
  return Math.max(0, Math.floor(session.Expiration.diff(DateTime.now()).milliseconds));
}

/**
 * Base name of the session cookie, before any `__Host-` / `__Secure-` prefix.
 */
export const SESSION_COOKIE_BASE_NAME = 'ssid';

/**
 * Everything an application may tune about the session cookie, read from
 * `rbac.session.cookie`. Unknown keys are passed through to express untouched,
 * so `domain`, `path`, `priority`… still work.
 *
 * `httpOnly` and `signed` are deliberately NOT tunable: a session cookie that
 * javascript can read, or that carries no signature, is not a session cookie
 * this package is willing to issue.
 */
export interface ISessionCookieConfig {
  /** Base cookie name. Default `ssid`. */
  name?: string;

  /**
   * Emit the cookie as `__Host-<name>`. The prefix is only honored by browsers
   * when the cookie is `Secure`, has `Path=/` and carries no `Domain`, so
   * enabling it forces exactly that and drops any configured `domain`.
   */
  hostPrefix?: boolean;

  /** Default `true`. Set false ONLY for local http development. */
  secure?: boolean;

  /** Default `strict`. */
  sameSite?: 'strict' | 'lax' | 'none' | boolean;

  [key: string]: unknown;
}

/** Keys consumed by this module rather than handed to express. */
const COOKIE_CONTROL_KEYS = ['name', 'hostPrefix'];

/**
 * Name the session cookie is issued and read under.
 *
 * @param config - the `rbac.session.cookie` configuration block
 */
export function sessionCookieName(config: ISessionCookieConfig = {}): string {
  const base = (config.name as string) ?? SESSION_COOKIE_BASE_NAME;
  return config.hostPrefix ? `__Host-${base}` : base;
}

/**
 * Cookie options for the session cookie.
 *
 * Application configuration is applied FIRST and the security-critical flags
 * last, so a stray `httpOnly: false` in an app config cannot downgrade the
 * cookie — previously every call site spread the config after its own hardening
 * and the config won. `secure` and `sameSite` stay tunable ( http development
 * needs `secure: false` ) but default to the hardened value rather than to
 * whatever the browser assumes.
 *
 * @param config - the `rbac.session.cookie` configuration block
 * @param maxAge - cookie lifetime in ms; `undefined` = browser-session cookie
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

  // A `__Host-` cookie is rejected by the browser unless it is Secure, rooted at
  // `/` and has no Domain. Enforce the whole set rather than emitting a cookie
  // the client will silently drop.
  if (config.hostPrefix) {
    options.secure = true;
    options.path = '/';
    delete options.domain;
  }

  return options;
}

/**
 * Session cookie in the shape the http `Coockies` response option accepts.
 */
export interface ISessionCookieDescriptor {
  Name: string;
  Value: string;
  Options: Record<string, unknown>;
}

/**
 * Descriptor of the session cookie carrying an active session, in the shape the
 * http `Coockies` response option accepts.
 *
 * @param session - session whose id and expiration the cookie carries
 * @param config - the `rbac.session.cookie` configuration block
 */
export function sessionCookie(session: ISession, config: ISessionCookieConfig = {}): ISessionCookieDescriptor {
  return {
    Name: sessionCookieName(config),
    Value: session.SessionId,
    Options: {
      ...sessionCookieOptions(config, sessionCookieMaxAge(session)),
      signed: true,
    },
  };
}

/**
 * Descriptor of an already-expired session cookie — clears the session client
 * side on logout.
 *
 * @param config - the `rbac.session.cookie` configuration block
 */
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

/**
 * Stable, non-reversible handle for a session id.
 *
 * Session ids must never reach a log file or a response body — a leaked log is
 * then a leaked account. The hash correlates entries across the session's life
 * and identifies a session in the "active devices" API without handing the
 * caller a usable credential for it.
 *
 * @param sessionId - raw session id
 */
export function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(`spinajs:session:${sessionId}`).digest('hex').substring(0, 32);
}

/**
 * Session-fixation protection helper. Mints a NEW session id, copies the
 * ownership identity and data across, deletes the old id and persists the new
 * one. Apply on privilege elevation (login already mints a fresh session, but
 * 2FA-authorize and role-switch elevate an existing one).
 *
 * The returned session carries a new `SessionId` so the caller can reset the
 * `ssid` cookie. `Expiration` is left unset so `save` schedules a fresh one via
 * the configured strategy (`Creation` is preserved, so a capped lifetime window
 * is not extended).
 *
 * @param provider - the active session store
 * @param session - the session to regenerate
 */
export async function regenerateSession(provider: SessionProvider, session: ISession): Promise<ISession> {
  const regenerated = new UserSession({
    UserId: session.UserId,
    Creation: session.Creation,
    Data: new Map(session.Data),
  });

  await provider.delete(session.SessionId);
  await provider.save(regenerated);

  return regenerated;
}

/**
 * Simple session storage in memory, for testing or rapid prototyping.
 * Keeps live session objects (no serialization).
 */
@Injectable(SessionProvider)
export class MemorySessionStore extends SessionProvider<ISession> {
  protected Sessions: Map<string, ISession> = new Map<string, ISession>();

  public async restore(sessionId: string): Promise<ISession | null> {
    const session = this.Sessions.get(sessionId);
    if (!session) {
      return null;
    }

    // an expired row is treated as absent (and evicted)
    if (this.isExpired(session)) {
      this.Sessions.delete(sessionId);
      return null;
    }

    return session;
  }

  public async save(session: ISession): Promise<void> {
    // A brand-new session without a scheduled expiration gets its initial
    // expiration from the strategy. An already-scheduled expiration is
    // persisted verbatim (fixes B3 — never recompute on every save).
    if (session.Expiration === undefined) {
      this.applyInitialExpiration(session);
    }

    this.Sessions.set(session.SessionId, session);
  }

  public async touch(session: ISession): Promise<boolean> {
    const current = session.Expiration;
    const renewed = this.Expiration.renew(session);

    // no change (e.g. AbsoluteExpiration) — skip the write, report false
    if (this.expirationEquals(current, renewed)) {
      return false;
    }

    session.Expiration = renewed;
    this.Sessions.set(session.SessionId, session);
    return true;
  }

  public async delete(sessionId: string): Promise<void> {
    this.Sessions.delete(sessionId);
  }

  public async deleteByUser(userId: number): Promise<void> {
    for (const [key, session] of this.Sessions.entries()) {
      if (session.UserId === userId) {
        this.Sessions.delete(key);
      }
    }
  }

  public async listByUser(userId: number): Promise<ISession[]> {
    const result: ISession[] = [];
    for (const session of this.Sessions.values()) {
      if (session.UserId === userId && !this.isExpired(session)) {
        result.push(session);
      }
    }
    return result;
  }

  public async truncate(): Promise<void> {
    this.Sessions = new Map<string, ISession>();
  }

  private expirationEquals(a: DateTime | undefined, b: DateTime | undefined): boolean {
    if (a === undefined || b === undefined) {
      return a === b;
    }
    return a.toMillis() === b.toMillis();
  }
}
