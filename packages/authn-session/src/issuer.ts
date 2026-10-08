import { createHash, randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';
import { Injectable } from '@spinajs/di';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { AutoinjectService, Config } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthnFacts, IdentityRef, PrincipalRef, SessionHandle } from '@spinajs/authn/contracts';
import { SessionProvider } from './contracts.js';
import type { ISession } from './contracts.js';
import { UserSession } from './session.js';
import { sameRef } from './match.js';
import { LEGACY_IDENTITY_KEYS, isLegacySessionId } from './legacy.js';

/** Client IP shown by `list`; set by the HTTP layer through `set` (the issuer takes no request context). */
export const SESSION_IP_KEY = 'Ip';

/** Client user agent shown by `list`; set like SESSION_IP_KEY. */
export const SESSION_USER_AGENT_KEY = 'UserAgent';

/**
 * In `restore(...).data` of a pending session only: the MFA steps it waits for, a frozen,
 * non-empty `readonly string[]`. Absent when the steps are unknown (a migrated 2.x row): the
 * flow then picks them from the subject's enrolled factors and must never elevate on no step.
 * Reserved, so `set` refuses it.
 */
export const SESSION_PENDING_STEPS_KEY = 'authn:pendingSteps';

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

/** Storage key of a handle, or null for a malformed one. */
const keyOf = (h: SessionHandle | undefined): string | null => {
  const id: unknown = h?.id;
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_RAW_ID_LENGTH ? storageKeyOf(id) : null;
};

/** 2.x login-state entries; a migrated row must not carry them (a 2.x reader would take `Logged` as logged in). */
const LEGACY_LOGIN_KEYS = ['Logged', 'TwoFactorAuth'];

/** A role from the removed 2.x RBAC model; 3.0 would read it as the role ceiling, so such a row is revoked (C2 cutover). */
const LEGACY_ACTIVE_ROLE_KEY = 'ActiveRole';

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

  public async restore(rawId: string): Promise<Restored | null> {
    if (typeof rawId !== 'string' || rawId.length === 0 || rawId.length > MAX_RAW_ID_LENGTH) {
      return null;
    }

    let session = await this.Store.restore(storageKeyOf(rawId));
    if (!session && isLegacySessionId(rawId)) {
      session = await this.migrate(rawId);
    }
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
    // The store checked the row before the renewal; a just-migrated 2.x row past maxLifetime is only caught here.
    if (isExpired(session)) {
      await this.Store.delete(session.SessionId);
      return null;
    }

    return {
      handle: { id: rawId, state: session.State },
      identity: ref(session.Subject),
      facts: this.factsOf(session, stored),
      data: this.publicData(session),
    };
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
    if (typeof key !== 'string' || key.startsWith(RESERVED_PREFIX) || REFUSED_KEYS.has(key)) {
      throw new InvalidArgument(`Session key ${String(key)} is reserved`, 'key');
    }
    const session = await this.need(h);
    session.Data.set(key, value);
    // touch is the store's update-only write, so a revocation since the read stays in force.
    await this.Store.touch(session);
    if (!(await this.Store.restore(session.SessionId))) {
      throw new InvalidOperation('Unknown or expired session');
    }
  }

  public async revoke(h: SessionHandle): Promise<void> {
    const key = keyOf(h);
    if (key === null) {
      return;
    }
    await this.Store.delete(key);
    if (isLegacySessionId(h.id)) {
      await this.Store.delete(h.id);
    }
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
    let found = false;
    // Every match: an interrupted migration can leave the raw and the hashed row under one handle.
    for (const session of await this.Store.listBySubject(ref(subject))) {
      if (sameRef(session.Subject, subject) && this.handleOfRow(session) === handle) {
        await this.Store.delete(session.SessionId);
        if (isLegacySessionId(session.SessionId)) {
          await this.Store.delete(storageKeyOf(session.SessionId));
        }
        found = true;
      }
    }
    return found;
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

  /** An unmigrated 2.x row is listed under the handle of its future key, so the handle survives migration. */
  protected handleOfRow(session: ISession): string {
    return sessionHandleOf(isLegacySessionId(session.SessionId) ? storageKeyOf(session.SessionId) : session.SessionId);
  }

  /**
   * Re-saves a 2.x row (raw uuid key) under sha256(raw) and deletes the raw
   * row (A07). 2.x data cannot show that MFA passed, so the facts are aal1
   * with authenticatedAt = Creation; a row that never passed 2FA stays
   * pending and lives at most pendingTtlSeconds more. A row carrying an
   * ActiveRole is deleted instead and never migrated.
   */
  protected migrate(rawId: string): Promise<ISession | null> {
    // Parallel first uses in this process share one migration; see migrateOnce for other processes.
    let running = this.Migrations.get(rawId);
    if (!running) {
      running = this.migrateOnce(rawId).finally(() => this.Migrations.delete(rawId));
      this.Migrations.set(rawId, running);
    }
    return running;
  }

  protected readonly Migrations = new Map<string, Promise<ISession | null>>();

  protected async migrateOnce(rawId: string): Promise<ISession | null> {
    const legacy = await this.Store.restore(rawId);
    if (!legacy) {
      // Another process may have migrated it a moment ago.
      return this.Store.restore(storageKeyOf(rawId));
    }
    const role = legacy.Data.get(LEGACY_ACTIVE_ROLE_KEY);
    if (typeof role === 'string' && role.length > 0) {
      await this.Store.delete(rawId);
      return null;
    }

    const now = DateTime.now();
    const data = new Map(legacy.Data);
    for (const k of [...LEGACY_IDENTITY_KEYS, ...LEGACY_LOGIN_KEYS]) {
      data.delete(k);
    }
    data.set(FACTS_KEY, { method: 'password', strategy: 'local', assurance: 'aal1', mfa: [], authenticatedAt: legacy.Creation.toMillis() } satisfies StoredFacts);

    let expiration = legacy.Expiration;
    if (legacy.State === 'pending') {
      data.set(PENDING_KEY, { steps: [] });
      const cap = now.plus({ seconds: this.PendingTtlSeconds });
      expiration = !expiration || cap < expiration ? cap : expiration;
    }

    const migrated = new UserSession({
      SessionId: storageKeyOf(rawId),
      Subject: ref(legacy.Subject),
      Impersonator: legacy.Impersonator ? ref(legacy.Impersonator) : undefined,
      State: legacy.State,
      Creation: legacy.Creation,
      Expiration: expiration,
      Data: data,
    });
    await this.Store.save(migrated);
    // save is an upsert: when the raw row vanished since the read, a revocation (or, rarely, another
    // process migrating it) got there first; drop the copy and fail closed.
    if (!(await this.Store.restore(rawId))) {
      await this.Store.delete(migrated.SessionId);
      return null;
    }
    await this.Store.delete(rawId);
    return migrated;
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
   * reaches the copy, which already carries the subject.
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
    // save gave it the initial expiration, capped at Creation + maxLifetime: elevating a migrated 2.x row that old
    // yields a dead session, so end both rows and refuse.
    if (isExpired(moved)) {
      await this.Store.delete(moved.SessionId);
      await this.Store.delete(session.SessionId);
      throw new InvalidOperation('Unknown or expired session');
    }
    if (!(await this.Store.restore(session.SessionId))) {
      await this.Store.delete(moved.SessionId);
      throw new InvalidOperation('Unknown or expired session');
    }
    await this.Store.delete(session.SessionId);
    return { id: rawId, state: moved.State };
  }
}
