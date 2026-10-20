import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';
import { _check_arg, _custom, _is_string, _max_length, _non_empty, _try_check_arg } from '@spinajs/util';
import { Autoinject, Container, Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { AutoinjectService, Config } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { SessionIssuer, SessionKeys, resolveSession } from '@spinajs/authn/contracts';
import type { AuthnFacts, IdentityRef, PrincipalRef, Session, SessionHandle } from '@spinajs/authn/contracts';
import { SessionProvider } from './contracts.js';
import type { ISession } from './contracts.js';
import { UserSession } from './session.js';
import { sameRef } from './match.js';

/** Client IP shown by `list`; set by the HTTP layer through `set` (the issuer takes no request context). */
export const SESSION_IP_KEY = SessionKeys.Ip.name;

/** Client user agent shown by `list`; set like SESSION_IP_KEY. */
export const SESSION_USER_AGENT_KEY = SessionKeys.UserAgent.name;

/**
 * In `restore(...).data` of a pending session only: the MFA steps it waits for, a frozen,
 * non-empty `readonly string[]`. Absent when the session was issued with no steps: the flow
 * then picks them from the subject's enrolled factors and must never elevate on no step.
 * Reserved, so `set` refuses it.
 */
export const SESSION_PENDING_STEPS_KEY = SessionKeys.PendingSteps.name;

const RESERVED_PREFIX = 'authn:';
const FACTS_KEY = 'authn:facts';
const PENDING_KEY = 'authn:pending';
const LAST_SEEN_KEY = 'authn:lastSeenAt';

/** Typed row members. */
const REFUSED_KEYS = new Set(['Subject', 'State', 'Impersonator']);

const LAST_SEEN_RESOLUTION_MS = 60_000;
const MAX_RAW_ID_LENGTH = 128;
const HANDLE_DOMAIN = 'spinajs:authn-session:handle\0';

interface StoredFacts {
  method: string;
  strategy: string;
  assurance: 'aal1' | 'aal2';
  mfa: string[];
  authenticatedAt: number;
}

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

export const storageKeyOf = (rawId: string): string => sha256hex(rawId);

const PEEKING = new AsyncLocalStorage<true>();

/**
 * Runs `fn` with every DefaultSessionIssuer.restore in it working as `peek`: a background re-check (a socket's
 * revalidation sweep) is no user activity, and code it calls, such as AuthnImpersonationService, restores again.
 */
export function peekingSessions<T>(fn: () => Promise<T>): Promise<T> {
  return PEEKING.run(true, fn);
}

/** Storage key of a handle, or null for a malformed one. */
const keyOf = (h: SessionHandle | undefined): string | null => {
  const id: unknown = h?.id;
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_RAW_ID_LENGTH ? storageKeyOf(id) : null;
};

/** The listed handle: one-way from the storage key, never the key or the raw id. */
export const sessionHandleOf = (storageKey: string): string => sha256hex(HANDLE_DOMAIN + storageKey);

const ref = (r: IdentityRef | PrincipalRef): IdentityRef => ({ type: r.type, id: r.id });

function toStored(f: AuthnFacts): StoredFacts {
  return { method: f.method, strategy: f.strategy, assurance: f.assurance, mfa: [...f.mfa], authenticatedAt: f.authenticatedAt.getTime() };
}

function pendingStepsOf(v: unknown): readonly string[] | null {
  const steps = (v as { steps?: unknown } | undefined)?.steps;
  const known = Array.isArray(steps) ? steps.filter((s): s is string => typeof s === 'string') : [];
  return known.length > 0 ? Object.freeze(known) : null;
}

const isExpired = (s: ISession): boolean => !!s.Expiration && s.Expiration <= DateTime.now();

function readStored(v: unknown): StoredFacts | null {
  const f = v as Partial<StoredFacts> | undefined;
  if (!f || typeof f.method !== 'string' || typeof f.strategy !== 'string' || (f.assurance !== 'aal1' && f.assurance !== 'aal2') || !Array.isArray(f.mfa) || typeof f.authenticatedAt !== 'number') {
    return null;
  }
  return f as StoredFacts;
}

@Injectable(SessionIssuer)
export class DefaultSessionIssuer extends SessionIssuer {
  @AutoinjectService('authn.session', SessionProvider)
  protected Store!: SessionProvider;

  @Autoinject(Container)
  protected Container!: IContainer;

  @Config('authn.session.pendingTtlSeconds')
  protected PendingTtlSeconds!: number;

  public async issue(identity: IdentityRef, facts: AuthnFacts, opts?: { pending?: { steps: readonly string[] } }): Promise<SessionHandle> {
    const now = DateTime.now();
    const pending = opts?.pending !== undefined;
    const data = new Map<string, unknown>([
      [FACTS_KEY, toStored(facts)],
      [LAST_SEEN_KEY, now.toMillis()],
    ]);
    if (pending) {
      data.set(PENDING_KEY, { steps: [...opts!.pending!.steps] });
    }

    const rawId = randomBytes(16).toString('base64url');
    await this.Store.save(
      new UserSession({
        SessionId: storageKeyOf(rawId),
        Subject: ref(identity),
        Impersonator: facts.impersonator ? ref(facts.impersonator) : undefined,
        State: pending ? 'pending' : 'active',
        Creation: now,
        Expiration: pending ? now.plus({ seconds: this.PendingTtlSeconds }) : undefined,
        Data: data,
      }),
    );
    return { id: rawId, state: pending ? 'pending' : 'active' };
  }

  /** `restore` without its side effects: checks the session but neither slides its idle deadline nor records lastSeenAt. */
  public peek(rawId: string): Promise<Session | null> {
    return peekingSessions(() => this.restore(rawId));
  }

  public async restore(rawId: string): Promise<Session | null> {
    const [ok] = _try_check_arg(_is_string(_non_empty(), _max_length(MAX_RAW_ID_LENGTH)))(rawId, 'rawId');
    if (!ok) {
      return null;
    }

    const session = await this.Store.restore(storageKeyOf(rawId));
    if (!session) {
      return null;
    }

    const stored = readStored(session.Data.get(FACTS_KEY));
    if (!stored) {
      return null;
    }

    if (session.State === 'active' && !PEEKING.getStore()) {
      await this.refresh(session);
    }
    // The store checked the row before the renewal; a renewal capped at Creation + maxLifetime can land in the past
    // (a lowered maxLifetime).
    if (isExpired(session)) {
      await this.Store.delete(session.SessionId);
      return null;
    }

    return resolveSession(this.Container, {
      handle: { id: rawId, state: session.State },
      identity: ref(session.Subject),
      facts: this.factsOf(session, stored),
      data: this.publicData(session),
    });
  }

  public async rotate(h: SessionHandle): Promise<SessionHandle> {
    const session = await this.need(h);
    return this.moveTo(session, new Map(session.Data), {});
  }

  public async elevate(h: SessionHandle, facts: Partial<AuthnFacts>): Promise<SessionHandle> {
    const session = await this.need(h);
    if (session.State !== 'pending') {
      throw new InvalidOperation('Only a pending session can be elevated');
    }
    const stored = readStored(session.Data.get(FACTS_KEY));
    if (!stored) {
      throw new InvalidOperation('Unknown or expired session');
    }

    const data = new Map(session.Data);
    data.delete(PENDING_KEY);
    data.set(
      FACTS_KEY,
      toStored({
        method: facts.method ?? stored.method,
        strategy: facts.strategy ?? stored.strategy,
        assurance: 'aal2',
        mfa: facts.mfa ?? stored.mfa,
        authenticatedAt: facts.authenticatedAt ?? new Date(stored.authenticatedAt),
      }),
    );
    // No expiration: the store gives the now-active session its initial one.
    return this.moveTo(session, data, { State: 'active', Expiration: undefined });
  }

  public async set(h: SessionHandle, key: string, value: unknown): Promise<void> {
    _check_arg(_is_string(_custom((k: string) => !k.startsWith(RESERVED_PREFIX) && !REFUSED_KEYS.has(k), new InvalidArgument(`Session key ${String(key)} is reserved`, 'key'))))(key, 'key');
    const session = await this.need(h);
    session.Data.set(key, value);
    // touch is the store's update-only write, so a revocation since the read stays in force.
    await this.Store.touch(session);
    if (!(await this.Store.restore(session.SessionId))) {
      throw new InvalidOperation('Unknown or expired session');
    }
  }

  public async revoke(h: SessionHandle): Promise<boolean> {
    const key = keyOf(h);
    if (key === null) {
      return false;
    }
    return this.Store.delete(key);
  }

  public async revokeAll(subject: IdentityRef, opts?: { except?: SessionHandle; includeImpersonations?: boolean }): Promise<number> {
    return this.Store.deleteBySubject(ref(subject), {
      includeImpersonations: opts?.includeImpersonations === true,
      except: opts?.except ? (keyOf(opts.except) ?? undefined) : undefined,
    });
  }

  public async revokeHandle(subject: IdentityRef, handle: string): Promise<boolean> {
    if (typeof handle !== 'string') {
      return false;
    }
    for (const session of await this.Store.listBySubject(ref(subject))) {
      if (sameRef(session.Subject, subject) && sessionHandleOf(session.SessionId) === handle) {
        await this.Store.delete(session.SessionId);
        return true;
      }
    }
    return false;
  }

  public async list(subject: IdentityRef, opts?: { current?: SessionHandle }): Promise<readonly { handle: string; createdAt: Date; lastSeenAt: Date; ip?: string; userAgent?: string; current?: boolean }[]> {
    const currentKey = opts?.current ? keyOf(opts.current) : null;
    const out: { handle: string; createdAt: Date; lastSeenAt: Date; ip?: string; userAgent?: string; current?: boolean }[] = [];
    for (const session of await this.Store.listBySubject(ref(subject))) {
      if (session.State !== 'active' || !sameRef(session.Subject, subject)) {
        continue;
      }
      const lastSeen = session.Data.get(LAST_SEEN_KEY);
      const ip = session.Data.get(SESSION_IP_KEY);
      const userAgent = session.Data.get(SESSION_USER_AGENT_KEY);
      out.push({
        handle: sessionHandleOf(session.SessionId),
        createdAt: session.Creation.toJSDate(),
        lastSeenAt: typeof lastSeen === 'number' ? new Date(lastSeen) : session.Creation.toJSDate(),
        ...(typeof ip === 'string' ? { ip } : {}),
        ...(typeof userAgent === 'string' ? { userAgent } : {}),
        ...(currentKey !== null && session.SessionId === currentKey ? { current: true } : {}),
      });
    }
    return out;
  }

  protected factsOf(session: ISession, stored: StoredFacts): AuthnFacts {
    return {
      method: stored.method,
      strategy: stored.strategy,
      assurance: stored.assurance,
      mfa: [...stored.mfa],
      authenticatedAt: new Date(stored.authenticatedAt),
      ...(session.Impersonator ? { impersonator: ref(session.Impersonator) as PrincipalRef } : {}),
      sessionHandle: sessionHandleOf(session.SessionId),
    };
  }

  protected publicData(session: ISession): ReadonlyMap<string, unknown> {
    const data = new Map<string, unknown>([...session.Data].filter(([k]) => !k.startsWith(RESERVED_PREFIX)));
    const steps = session.State === 'pending' ? pendingStepsOf(session.Data.get(PENDING_KEY)) : null;
    if (steps) {
      data.set(SESSION_PENDING_STEPS_KEY, steps);
    }
    return data;
  }

  /** Slides the idle deadline and records lastSeenAt (at most once a minute) in one update-only write. */
  protected async refresh(session: ISession): Promise<void> {
    const now = Date.now();
    const lastSeen = session.Data.get(LAST_SEEN_KEY);
    if (typeof lastSeen !== 'number' || now - lastSeen >= LAST_SEEN_RESOLUTION_MS) {
      session.Data.set(LAST_SEEN_KEY, now);
    }
    await this.Store.touch(session);
  }

  protected async need(h: SessionHandle): Promise<ISession> {
    const key = keyOf(h);
    if (key === null) {
      throw new InvalidArgument('Malformed session handle', 'h');
    }
    const session = await this.Store.restore(key);
    if (!session) {
      throw new InvalidOperation('Unknown or expired session');
    }
    return session;
  }

  /**
   * Re-keys a row under a fresh id. The new row is saved first; if the old row
   * vanished meanwhile (logout, ban), the copy is dropped, so a revocation that
   * lands during a rotation is never undone. A revokeAll after the check also
   * reaches the copy, which already carries the subject. Only the move whose
   * delete removed the old row keeps its copy, so of parallel rotations or
   * elevations of one session exactly one succeeds.
   */
  protected async moveTo(session: ISession, data: Map<string, unknown>, over: Partial<ISession>): Promise<SessionHandle> {
    const rawId = randomBytes(16).toString('base64url');
    const moved = new UserSession({
      SessionId: storageKeyOf(rawId),
      Subject: session.Subject,
      Impersonator: session.Impersonator,
      State: session.State,
      Creation: session.Creation,
      Expiration: session.Expiration,
      Data: data,
      ...over,
    });
    await this.Store.save(moved);
    // save gave it the initial expiration, capped at Creation + maxLifetime: a session already past that cap yields a
    // dead copy, so end both rows and refuse.
    if (isExpired(moved)) {
      await this.Store.delete(moved.SessionId);
      await this.Store.delete(session.SessionId);
      throw new InvalidOperation('Unknown or expired session');
    }
    // restore first: a delete also reports an expired row that the store has not swept yet.
    if (!(await this.Store.restore(session.SessionId)) || !(await this.Store.delete(session.SessionId))) {
      await this.Store.delete(moved.SessionId);
      throw new InvalidOperation('Unknown or expired session');
    }
    return { id: rawId, state: moved.State };
  }
}
