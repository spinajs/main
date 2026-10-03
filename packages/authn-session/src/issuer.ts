import { createHash, randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';
import { Injectable } from '@spinajs/di';
import { AutoinjectService, Config } from '@spinajs/configuration';
import { SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthnFacts, IdentityRef, PrincipalRef, SessionHandle } from '@spinajs/authn/contracts';
import { SessionProvider } from './contracts.js';
import type { ISession } from './contracts.js';
import { UserSession } from './session.js';
import { sameRef } from './match.js';

/** Client IP shown by `list`; set by the HTTP layer through `set` (the issuer takes no request context). */
export const SESSION_IP_KEY = 'Ip';

/** Client user agent shown by `list`; set like SESSION_IP_KEY. */
export const SESSION_USER_AGENT_KEY = 'UserAgent';

const RESERVED_PREFIX = 'authn:';
const FACTS_KEY = 'authn:facts';
const PENDING_KEY = 'authn:pending';
const LAST_SEEN_KEY = 'authn:lastSeenAt';

/** Typed row members, and the 2.x Data entries a store reads when it adapts a 2.x row. */
const REFUSED_KEYS = new Set(['Subject', 'State', 'Impersonator', 'User', 'Authorized']);

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

type Restored = { handle: SessionHandle; identity: IdentityRef; facts: AuthnFacts; data: ReadonlyMap<string, unknown> };

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

export const storageKeyOf = (rawId: string): string => sha256hex(rawId);

/** The listed handle: one-way from the storage key, never the key or the raw id. */
export const sessionHandleOf = (storageKey: string): string => sha256hex(HANDLE_DOMAIN + storageKey);

const ref = (r: IdentityRef | PrincipalRef): IdentityRef => ({ type: r.type, id: r.id });

function toStored(f: AuthnFacts): StoredFacts {
  return { method: f.method, strategy: f.strategy, assurance: f.assurance, mfa: [...f.mfa], authenticatedAt: f.authenticatedAt.getTime() };
}

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

  @Config('authn.session.pendingTtlSeconds', { defaultValue: 300 })
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

  public async restore(rawId: string): Promise<Restored | null> {
    if (typeof rawId !== 'string' || rawId.length === 0 || rawId.length > MAX_RAW_ID_LENGTH) {
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

    if (session.State === 'active') {
      await this.refresh(session);
    }

    return {
      handle: { id: rawId, state: session.State },
      identity: ref(session.Subject),
      facts: this.factsOf(session, stored),
      data: this.publicData(session.Data),
    };
  }

  public async rotate(h: SessionHandle): Promise<SessionHandle> {
    const session = await this.need(h);
    return this.moveTo(session, new Map(session.Data), {});
  }

  public async elevate(h: SessionHandle, facts: Partial<AuthnFacts>): Promise<SessionHandle> {
    const session = await this.need(h);
    if (session.State !== 'pending') {
      throw new Error('Only a pending session can be elevated');
    }
    const stored = readStored(session.Data.get(FACTS_KEY));
    if (!stored) {
      throw new Error('Unknown or expired session');
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
    if (typeof key !== 'string' || key.startsWith(RESERVED_PREFIX) || REFUSED_KEYS.has(key)) {
      throw new Error(`Session key ${String(key)} is reserved`);
    }
    const session = await this.need(h);
    session.Data.set(key, value);
    await this.Store.save(session);
  }

  public async revoke(h: SessionHandle): Promise<void> {
    await this.Store.delete(storageKeyOf(h.id));
  }

  public async revokeAll(subject: IdentityRef, opts?: { except?: SessionHandle; includeImpersonations?: boolean }): Promise<number> {
    return this.Store.deleteBySubject(ref(subject), {
      includeImpersonations: opts?.includeImpersonations === true,
      except: opts?.except ? storageKeyOf(opts.except.id) : undefined,
    });
  }

  public async revokeHandle(subject: IdentityRef, handle: string): Promise<boolean> {
    if (typeof handle !== 'string') {
      return false;
    }
    for (const session of await this.Store.listBySubject(ref(subject))) {
      if (sameRef(session.Subject, subject) && this.handleOfRow(session) === handle) {
        await this.Store.delete(session.SessionId);
        return true;
      }
    }
    return false;
  }

  public async list(subject: IdentityRef, opts?: { current?: SessionHandle }): Promise<readonly { handle: string; createdAt: Date; lastSeenAt: Date; ip?: string; userAgent?: string; current?: boolean }[]> {
    const currentKey = opts?.current ? storageKeyOf(opts.current.id) : null;
    const out: { handle: string; createdAt: Date; lastSeenAt: Date; ip?: string; userAgent?: string; current?: boolean }[] = [];
    for (const session of await this.Store.listBySubject(ref(subject))) {
      if (session.State !== 'active' || !sameRef(session.Subject, subject)) {
        continue;
      }
      const lastSeen = session.Data.get(LAST_SEEN_KEY);
      const ip = session.Data.get(SESSION_IP_KEY);
      const userAgent = session.Data.get(SESSION_USER_AGENT_KEY);
      out.push({
        handle: this.handleOfRow(session),
        createdAt: session.Creation.toJSDate(),
        lastSeenAt: typeof lastSeen === 'number' ? new Date(lastSeen) : session.Creation.toJSDate(),
        ...(typeof ip === 'string' ? { ip } : {}),
        ...(typeof userAgent === 'string' ? { userAgent } : {}),
        ...(currentKey !== null && session.SessionId === currentKey ? { current: true } : {}),
      });
    }
    return out;
  }

  protected handleOfRow(session: ISession): string {
    return sessionHandleOf(session.SessionId);
  }

  protected factsOf(session: ISession, stored: StoredFacts): AuthnFacts {
    return {
      method: stored.method,
      strategy: stored.strategy,
      assurance: stored.assurance,
      mfa: [...stored.mfa],
      authenticatedAt: new Date(stored.authenticatedAt),
      ...(session.Impersonator ? { impersonator: ref(session.Impersonator) as PrincipalRef } : {}),
      sessionHandle: this.handleOfRow(session),
    };
  }

  protected publicData(data: Map<string, unknown>): ReadonlyMap<string, unknown> {
    return new Map([...data].filter(([k]) => !k.startsWith(RESERVED_PREFIX)));
  }

  /** Slides the idle deadline and records lastSeenAt, the latter at most once a minute. */
  protected async refresh(session: ISession): Promise<void> {
    await this.Store.touch(session);
    const now = Date.now();
    const lastSeen = session.Data.get(LAST_SEEN_KEY);
    if (typeof lastSeen !== 'number' || now - lastSeen >= LAST_SEEN_RESOLUTION_MS) {
      session.Data.set(LAST_SEEN_KEY, now);
      await this.Store.save(session);
    }
  }

  protected async need(h: SessionHandle): Promise<ISession> {
    const session = typeof h?.id === 'string' ? await this.Store.restore(storageKeyOf(h.id)) : null;
    if (!session) {
      throw new Error('Unknown or expired session');
    }
    return session;
  }

  /** Re-keys a row under a fresh id: the new row is saved before the old one is deleted. */
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
    await this.Store.delete(session.SessionId);
    return { id: rawId, state: moved.State };
  }
}
