import { Redis, RedisOptions } from 'ioredis';
import type { ChainableCommander } from 'ioredis';
import { DateTime } from 'luxon';

import { SessionProvider, UserSession, encodeSessionData, decodeSessionData, adaptLegacySession } from '@spinajs/authn-session';
import type { ISession } from '@spinajs/authn-session';
import { principalKey } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Logger, Log } from '@spinajs/log';

/** The JSON value of `session:<SessionId>`. A 3.0 row has Subject; a 2.x row has UserId and its identity in Data. */
interface IStoredSession {
  Subject?: string;
  Impersonator?: string;
  State?: string;
  UserId?: number;
  Creation: string;
  Expiration?: string;
  Data: unknown;
}

type IndexRole = 'subject' | 'impersonator';

interface IIndexSet {
  key: string;
  role: IndexRole;
}

/** Compare-and-set: writes only when the key still holds the value touch read, so a deleted row stays deleted. */
const TOUCH_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
if ARGV[3] == '' then redis.call('PERSIST', KEYS[1]) else redis.call('PEXPIREAT', KEYS[1], ARGV[3]) end
return 1`;

const TOUCH_ATTEMPTS = 10;

const sameRef = (a: IdentityRef | undefined, b: IdentityRef) => !!a && a.type === b.type && a.id === b.id;

/** Inverse of principalKey: the type ends at the first ':' and has ':' and '%' escaped. */
function refOf(key: unknown): IdentityRef | undefined {
  if (typeof key !== 'string') {
    return undefined;
  }
  const at = key.indexOf(':');
  if (at <= 0) {
    return undefined;
  }
  return { type: key.slice(0, at).replace(/%(25|3A)/g, (_, code: string) => (code === '25' ? '%' : ':')), id: key.slice(at + 1) };
}

/**
 * Redis-backed session store (ioredis).
 *
 * Keys (under the connection `keyPrefix`):
 *  - `session:<SessionId>`: the row as JSON, with Subject / Impersonator as
 *    principal keys and State; PEXPIREAT at its Expiration
 *  - `session:subject:<principalKey>`, `session:impersonator:<principalKey>`:
 *    sets of SessionIds (SR-06); dead members are pruned when met
 *
 * 2.x rows (no Subject, indexed only in `session:user:<UserId>`) are added to
 * the new sets by the sweep that runs on resolve(). Liveness is always judged
 * with `isExpired` in Node; the Redis TTL only frees memory.
 */
@Injectable(SessionProvider)
export class RedisSessionStore extends SessionProvider {
  @Logger('redis-session-store')
  protected Log: Log;

  @Config('authn.session.redis')
  protected RedisConfig: RedisOptions;

  protected Client: Redis;

  public async resolve() {
    this.Client = this.createClient();
    await this.sweepLegacy();
  }

  public async dispose() {
    this.Client?.disconnect();
  }

  public async restore(sessionId: string): Promise<ISession | null> {
    const raw = await this.Client.get(this.sessionKey(sessionId));
    if (!raw) {
      return null;
    }

    const session = this.toSession(sessionId, raw);
    if (!session) {
      return null;
    }

    if (this.isExpired(session)) {
      await this.delete(sessionId);
      return null;
    }

    return session;
  }

  public async save(session: ISession): Promise<void> {
    if (session.Expiration === undefined) {
      this.applyInitialExpiration(session);
    }

    const key = this.sessionKey(session.SessionId);
    const previousRaw = await this.Client.get(key);
    const previous = previousRaw ? this.toSession(session.SessionId, previousRaw, true) : null;

    const stored: IStoredSession = {
      Subject: principalKey(session.Subject),
      Impersonator: session.Impersonator ? principalKey(session.Impersonator) : undefined,
      State: session.State,
      Creation: session.Creation.toISO()!,
      Expiration: session.Expiration ? session.Expiration.toISO()! : undefined,
      Data: encodeSessionData(session.Data),
    };

    const sets = this.indexSetsOf(session).map((s) => s.key);
    const multi = this.Client.multi().set(key, JSON.stringify(stored));
    this.expireAt(multi, key, session.Expiration);
    for (const set of sets) {
      multi.sadd(set, session.SessionId);
    }
    for (const old of previous ? this.indexSetsOf(previous) : []) {
      if (!sets.includes(old.key)) {
        multi.srem(old.key, session.SessionId);
      }
    }
    await this.exec(multi);
  }

  /**
   * Update-only: writes Expiration and Data of a row that still exists, is
   * live and is stored in the caller's State (SR-07), through a
   * compare-and-set on the value it read; a lost race reads again.
   */
  public async touch(session: ISession): Promise<boolean> {
    const current = session.Expiration;
    this.applyRenewedExpiration(session);
    const key = this.sessionKey(session.SessionId);

    for (let attempt = 0; attempt < TOUCH_ATTEMPTS; attempt++) {
      const raw = await this.Client.get(key);
      const row = raw ? this.toSession(session.SessionId, raw, true) : null;
      if (!raw || !row || row.State !== session.State || this.isExpired(row)) {
        session.Expiration = current;
        return false;
      }

      // The row keeps its own identity fields (and a 2.x row its 2.x shape).
      const next = JSON.stringify({ ...(JSON.parse(raw) as IStoredSession), Expiration: session.Expiration?.toISO() ?? undefined, Data: encodeSessionData(session.Data) });
      const written = await this.Client.eval(TOUCH_SCRIPT, 1, key, raw, next, session.Expiration ? String(session.Expiration.toMillis()) : '');
      if (Number(written) === 1) {
        return !this.expirationEquals(current, session.Expiration);
      }
    }

    session.Expiration = current;
    throw new Error(`Session touch lost ${TOUCH_ATTEMPTS} races in a row`);
  }

  public async delete(sessionId: string): Promise<void> {
    const key = this.sessionKey(sessionId);
    const raw = await this.Client.get(key);
    const row = raw ? this.toSession(sessionId, raw, true) : null;

    const multi = this.Client.multi().del(key);
    for (const set of row ? this.indexSetsOf(row) : []) {
      multi.srem(set.key, sessionId);
    }
    await this.exec(multi);
  }

  /**
   * List-then-delete over the index sets, repeated until no new member shows
   * up, so a row saved during the call (a rotation racing a ban) also ends.
   * Only rows that are live when read count.
   */
  public async deleteBySubject(subject: IdentityRef, opts?: { includeImpersonations?: boolean; except?: string }): Promise<number> {
    const seen = new Set<string>();
    let count = 0;

    for (;;) {
      const found = await this.lookup(subject, opts?.includeImpersonations, (id) => id !== opts?.except && !seen.has(id));
      if (found.ids.length === 0) {
        return count;
      }
      found.ids.forEach((id) => seen.add(id));

      const multi = this.Client.multi();
      for (const row of found.rows) {
        multi.del(this.sessionKey(row.SessionId));
        for (const set of this.indexSetsOf(row)) {
          multi.srem(set.key, row.SessionId);
        }
      }
      this.prune(multi, found.stale);
      const results = await this.exec(multi);

      // Each matched row queued its DEL first, then its SREMs.
      let at = 0;
      for (const row of found.rows) {
        if (Number(results[at]) === 1 && !this.isExpired(row)) {
          count++;
        }
        at += 1 + this.indexSetsOf(row).length;
      }
    }
  }

  public async listBySubject(subject: IdentityRef, opts?: { includeImpersonations?: boolean }): Promise<ISession[]> {
    const found = await this.lookup(subject, opts?.includeImpersonations, () => true);
    const live = found.rows.filter((s) => !this.isExpired(s));
    const expired = found.rows.filter((s) => this.isExpired(s));

    if (expired.length > 0 || found.stale.length > 0) {
      const multi = this.Client.multi();
      for (const row of expired) {
        multi.del(this.sessionKey(row.SessionId));
        for (const set of this.indexSetsOf(row)) {
          multi.srem(set.key, row.SessionId);
        }
      }
      this.prune(multi, found.stale);
      await this.exec(multi);
    }

    return live;
  }

  public async truncate(): Promise<void> {
    // Only keys this store owns (session rows and index sets); never a blind FLUSHDB.
    await this.scanSessionKeys(async (keys) => {
      await this.Client.del(...keys);
    });
  }

  /**
   * Adds every 2.x row (no Subject) to the subject / impersonator sets, so
   * deleteBySubject and listBySubject reach it. Idempotent. Runs on
   * resolve(); 2.x nodes that write rows after it (rolling upgrade) need it
   * run again once they are gone.
   *
   * @returns how many 2.x rows were indexed
   */
  public async sweepLegacy(): Promise<number> {
    let indexed = 0;

    await this.scanSessionKeys(async (keys) => {
      const ids = keys.map((k) => k.slice('session:'.length)).filter((id) => !id.includes(':'));
      if (ids.length === 0) {
        return;
      }

      const values = await this.Client.mget(...ids.map((id) => this.sessionKey(id)));
      const rows = ids.map((id, i) => (values[i] && !this.isStored30(values[i]!) ? this.toSession(id, values[i]!, true) : null)).filter((row): row is ISession => !!row);
      if (rows.length === 0) {
        return;
      }

      const multi = this.Client.multi();
      for (const row of rows) {
        for (const set of this.indexSetsOf(row)) {
          multi.sadd(set.key, row.SessionId);
        }
      }
      await this.exec(multi);
      indexed += rows.length;
    });

    this.Log.info(`Indexed ${indexed} 2.x sessions by subject and impersonator`);
    return indexed;
  }

  protected createClient(): Redis {
    // The whole config object goes to ioredis (host, port, password, db, keyPrefix, tls, ...).
    return new Redis(this.RedisConfig ?? {});
  }

  protected sessionKey(sessionId: string): string {
    return `session:${sessionId}`;
  }

  protected indexKey(role: IndexRole, ref: IdentityRef): string {
    return `session:${role}:${principalKey(ref)}`;
  }

  protected indexSetsOf(session: ISession): IIndexSet[] {
    const sets: IIndexSet[] = [{ key: this.indexKey('subject', session.Subject), role: 'subject' }];
    if (session.Impersonator) {
      sets.push({ key: this.indexKey('impersonator', session.Impersonator), role: 'impersonator' });
    }
    return sets;
  }

  /**
   * Members of the subject's sets that pass `accept`, read in one MGET:
   * `rows` are the rows that belong to the subject (expired ones included),
   * `stale` the memberships whose row is gone, unreadable or no longer the
   * subject's.
   */
  protected async lookup(subject: IdentityRef, includeImpersonations: boolean | undefined, accept: (id: string) => boolean): Promise<{ ids: string[]; rows: ISession[]; stale: [string, string][] }> {
    const sets: IIndexSet[] = [{ key: this.indexKey('subject', subject), role: 'subject' }];
    if (includeImpersonations === true) {
      sets.push({ key: this.indexKey('impersonator', subject), role: 'impersonator' });
    }

    const sources = new Map<string, IIndexSet[]>();
    for (const set of sets) {
      for (const id of await this.Client.smembers(set.key)) {
        if (accept(id)) {
          sources.set(id, [...(sources.get(id) ?? []), set]);
        }
      }
    }

    const ids = [...sources.keys()];
    if (ids.length === 0) {
      return { ids, rows: [], stale: [] };
    }

    const values = await this.Client.mget(...ids.map((id) => this.sessionKey(id)));
    const rows: ISession[] = [];
    const stale: [string, string][] = [];
    ids.forEach((id, i) => {
      const raw = values[i];
      const row = raw ? this.toSession(id, raw, true) : null;
      let matched = false;
      for (const set of sources.get(id)!) {
        if (row && sameRef(set.role === 'subject' ? row.Subject : row.Impersonator, subject)) {
          matched = true;
        } else {
          stale.push([set.key, id]);
        }
      }
      if (matched) {
        rows.push(row!);
      }
    });

    return { ids, rows, stale };
  }

  protected prune(multi: ChainableCommander, stale: [string, string][]): void {
    for (const [set, id] of stale) {
      multi.srem(set, id);
    }
  }

  /** Runs `each` on every batch of this store's keys, with the connection keyPrefix stripped (the client adds it back). */
  protected async scanSessionKeys(each: (keys: string[]) => Promise<void>): Promise<void> {
    const prefix = this.Client.options.keyPrefix ?? '';
    let cursor = '0';
    do {
      // SCAN patterns and replies are not prefixed by ioredis.
      const [next, keys] = await this.Client.scan(cursor, 'MATCH', `${prefix}session:*`, 'COUNT', 500);
      cursor = next;
      if (keys.length > 0) {
        await each(keys.map((k) => (prefix && k.startsWith(prefix) ? k.slice(prefix.length) : k)));
      }
    } while (cursor !== '0');
  }

  protected isStored30(raw: string): boolean {
    try {
      return typeof (JSON.parse(raw) as IStoredSession | null)?.Subject === 'string';
    } catch {
      return false;
    }
  }

  /**
   * The 3.0 view of a stored value; null for a 2.x row without an owner.
   * `lenient` (lookups, the sweep, touch): an unparseable value is absent,
   * and a row whose Data does not decode keeps the owner its fields give
   * with an empty Data, so one bad row cannot make a revokeAll throw for
   * everybody; a 2.x row then has no owner.
   */
  protected toSession(sessionId: string, raw: string, lenient = false): ISession | null {
    let stored: IStoredSession;
    let data: Map<string, unknown>;
    try {
      stored = JSON.parse(raw) as IStoredSession;
      if (!stored || typeof stored !== 'object') {
        throw new Error(`Session ${sessionId} is not a JSON object`);
      }
    } catch (err) {
      if (!lenient) {
        throw err;
      }
      this.Log.warn(`Unreadable session value skipped`);
      return null;
    }
    try {
      data = decodeSessionData(stored.Data);
    } catch (err) {
      if (!lenient) {
        throw err;
      }
      this.Log.warn(`Session with undecodable Data read without its Data`);
      data = new Map();
    }

    const session = new UserSession({
      SessionId: sessionId,
      Creation: DateTime.fromISO(stored.Creation),
      Expiration: stored.Expiration ? this.instant(stored.Expiration) : undefined,
      Data: data,
    });

    const subject = refOf(stored.Subject);
    if (!subject) {
      return adaptLegacySession(session);
    }

    session.Subject = subject;
    session.Impersonator = refOf(stored.Impersonator);
    session.State = stored.State === 'active' ? 'active' : 'pending';
    return session;
  }

  /** An Expiration that does not parse counts as already passed. */
  protected instant(iso: string): DateTime {
    const at = DateTime.fromISO(iso);
    return at.isValid ? at : DateTime.fromMillis(0);
  }

  protected expireAt(multi: ChainableCommander, key: string, expiration: DateTime | undefined): void {
    if (expiration !== undefined) {
      multi.pexpireat(key, expiration.toMillis());
    } else {
      multi.persist(key);
    }
  }

  protected async exec(multi: ChainableCommander): Promise<unknown[]> {
    const results = (await multi.exec()) ?? [];
    const failed = results.find(([err]) => err);
    if (failed) {
      throw failed[0];
    }
    return results.map(([, value]) => value);
  }

  protected expirationEquals(a: DateTime | undefined, b: DateTime | undefined): boolean {
    if (a === undefined || b === undefined) {
      return a === b;
    }
    return a.toMillis() === b.toMillis();
  }
}
