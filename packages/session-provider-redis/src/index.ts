import { Redis, RedisOptions } from 'ioredis';
import type { ChainableCommander } from 'ioredis';
import { DateTime } from 'luxon';

import { SessionProvider, UserSession, encodeSessionData, decodeSessionData } from '@spinajs/authn-session';
import type { ISession } from '@spinajs/authn-session';
import { principalKey } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import '@spinajs/authn-session/register-schema';
import { Logger, Log } from '@spinajs/log';

/** The JSON value of `session:<SessionId>`. */
interface IStoredSession {
  Subject: string;
  Impersonator?: string;
  State: string;
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
 * Liveness is always judged with `isExpired` in Node; the Redis TTL only frees
 * memory.
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
    this.Client.on('error', (err: Error) => this.Log.error(err, 'Redis connection error'));
  }

  public async dispose() {
    if (!this.Client) {
      return;
    }
    try {
      await this.Client.quit();
    } catch {
      this.Client.disconnect();
    }
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

      // The row keeps its own identity fields.
      const next = JSON.stringify({ ...(JSON.parse(raw) as IStoredSession), Expiration: session.Expiration?.toISO() ?? undefined, Data: encodeSessionData(session.Data) });
      const written = await this.Client.eval(TOUCH_SCRIPT, 1, key, raw, next, session.Expiration ? String(session.Expiration.toMillis()) : '');
      if (Number(written) === 1) {
        return !this.expirationEquals(current, session.Expiration);
      }
    }

    session.Expiration = current;
    throw new Error(`Session touch lost ${TOUCH_ATTEMPTS} races in a row`);
  }

  public async delete(sessionId: string): Promise<boolean> {
    const key = this.sessionKey(sessionId);
    const raw = await this.Client.get(key);
    const row = raw ? this.toSession(sessionId, raw, true) : null;

    const multi = this.Client.multi().del(key);
    for (const set of row ? this.indexSetsOf(row) : []) {
      multi.srem(set.key, sessionId);
    }
    const [deleted] = await this.exec(multi);
    return deleted === 1;
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

  public async deleteByExternalKey(_externalKey: string): Promise<number> {
    throw new Error('not implemented: RedisSessionStore.deleteByExternalKey');
  }

  public async truncate(): Promise<void> {
    // Only keys this store owns (session rows and index sets); never a blind FLUSHDB.
    await this.scanSessionKeys(async (keys) => {
      await this.Client.del(...keys);
    }, this.keyPatterns());
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

  /** Patterns (without the connection keyPrefix) covering session rows and both kinds of index sets. */
  protected keyPatterns(): string[] {
    const any: IdentityRef = { type: '*', id: '*' };
    return [...new Set([this.sessionKey('*'), this.indexKey('subject', any), this.indexKey('impersonator', any)])];
  }

  /** Runs `each` on every batch of keys matching `patterns`, with the connection keyPrefix stripped (the client adds it back). */
  protected async scanSessionKeys(each: (keys: string[]) => Promise<void>, patterns: string[] = this.keyPatterns()): Promise<void> {
    const prefix = this.Client.options.keyPrefix ?? '';
    // SCAN patterns and replies are not prefixed by ioredis; glob characters in the prefix must match literally.
    const escapedPrefix = prefix.replace(/[\\*?[\]]/g, '\\$&');
    const seen = new Set<string>();
    for (const pattern of patterns) {
      let cursor = '0';
      do {
        const [next, keys] = await this.Client.scan(cursor, 'MATCH', `${escapedPrefix}${pattern}`, 'COUNT', 500);
        cursor = next;
        const fresh = keys.filter((k) => !seen.has(k));
        fresh.forEach((k) => seen.add(k));
        if (fresh.length > 0) {
          await each(fresh.map((k) => (prefix && k.startsWith(prefix) ? k.slice(prefix.length) : k)));
        }
      } while (cursor !== '0');
    }
  }

  /**
   * The session of a stored value; null for a value without a readable Subject.
   * `lenient` (lookups, touch): an unparseable value is absent, and a row whose
   * Data does not decode keeps the owner its fields give with an empty Data, so
   * one bad row cannot make a revokeAll throw.
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
      this.Log.warn(`Unreadable value of session ${sessionId} skipped`);
      return null;
    }

    const subject = refOf(stored.Subject);
    if (!subject) {
      return null;
    }

    try {
      data = decodeSessionData(stored.Data);
    } catch (err) {
      if (!lenient) {
        throw err;
      }
      this.Log.warn(`Session ${sessionId} has undecodable Data, read without its Data`);
      data = new Map();
    }

    return new UserSession({
      SessionId: sessionId,
      Subject: subject,
      Impersonator: refOf(stored.Impersonator),
      State: stored.State === 'active' ? 'active' : 'pending',
      Creation: DateTime.fromISO(stored.Creation),
      Expiration: stored.Expiration ? this.instant(stored.Expiration) : undefined,
      Data: data,
    });
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
