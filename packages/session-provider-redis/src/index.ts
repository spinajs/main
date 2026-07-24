import { Redis, RedisOptions } from 'ioredis';
import { DateTime } from 'luxon';

import { SessionProvider, ISession, UserSession, encodeSessionData, decodeSessionData } from '@spinajs/rbac';
import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Logger, Log } from '@spinajs/log';

/**
 * Shape of a session as persisted in Redis (one JSON string per key). Ownership
 * is the numeric `UserId`; `Creation` / `Expiration` are ISO instants; `Data` is
 * (de)serialized with the shared session codec.
 */
interface IStoredSession {
  UserId: number;
  Creation: string;
  Expiration?: string;
  Data: string;
}

/**
 * Redis-backed session store (ioredis). Conforms to the `@spinajs/rbac`
 * `SessionProvider` contract: ownership is the numeric `UserId`, expiration is
 * owned by the injected strategy (`this.Expiration`) and persisted verbatim, and
 * `Data` is (de)serialized with the shared session codec.
 *
 * Key layout (all under the optional connection `keyPrefix`):
 *  - `session:${SessionId}`      → the encoded session JSON
 *  - `session:user:${UserId}`    → a SET of that user's session ids (the index
 *    that keeps `deleteByUser` / `listByUser` O(members) instead of a full scan)
 *
 * Redis TTL mirrors `session.Expiration` (`PEXPIREAT` epoch-millis, `PERSIST` for
 * a never-expiring session), but `restore` / `listByUser` also gate on
 * `isExpired` explicitly — Redis TTL eviction is not relied upon for correctness.
 */
@Injectable(SessionProvider)
export class RedisSessionStore extends SessionProvider {
  @Logger('redis-session-store')
  protected Log: Log;

  @Config('rbac.session.redis')
  protected RedisConfig: RedisOptions;

  protected Client: Redis;

  public async resolve() {
    // The whole config object is passed straight to ioredis (host/port/password/
    // db/keyPrefix/tls/… are all honored).
    this.Client = new Redis(this.RedisConfig ?? {});
  }

  public async restore(sessionId: string): Promise<ISession | null> {
    const raw = await this.Client.get(this.sessionKey(sessionId));
    if (!raw) {
      return null;
    }

    const session = this.toSession(sessionId, raw);

    // Redis TTL eviction is eventual / clock-dependent — treat an expired
    // session as absent, matching the contract, and self-heal the key.
    if (this.isExpired(session)) {
      await this.delete(sessionId);
      return null;
    }

    return session;
  }

  public async save(session: ISession): Promise<void> {
    // Persist `Expiration` verbatim. Only a brand-new session with no scheduled
    // expiration is given its initial expiry via the strategy (fixes B3).
    if (session.Expiration === undefined) {
      this.applyInitialExpiration(session);
    }

    const stored: IStoredSession = {
      UserId: session.UserId,
      Creation: session.Creation.toISO()!,
      Expiration: session.Expiration ? session.Expiration.toISO()! : undefined,
      Data: encodeSessionData(session.Data),
    };

    const key = this.sessionKey(session.SessionId);
    await this.Client.set(key, JSON.stringify(stored));

    // Drive the Redis TTL from the session's real expiration; a never-expiring
    // session simply has no TTL.
    if (session.Expiration !== undefined) {
      await this.Client.pexpireat(key, session.Expiration.toMillis());
    } else {
      await this.Client.persist(key);
    }

    // Maintain the per-user index set so deleteByUser / listByUser stay O(members).
    await this.Client.sadd(this.userKey(session.UserId), session.SessionId);
  }

  public async touch(session: ISession): Promise<boolean> {
    const current = session.Expiration;
    const renewed = this.Expiration.renew(session);

    // unchanged (e.g. AbsoluteExpiration) — skip the write, report false
    if (this.expirationEquals(current, renewed)) {
      return false;
    }

    session.Expiration = renewed;
    // re-persist verbatim + reset the Redis TTL (save handles PEXPIREAT/PERSIST)
    await this.save(session);

    return true;
  }

  public async delete(sessionId: string): Promise<void> {
    // read first so we know which user index set to prune
    const raw = await this.Client.get(this.sessionKey(sessionId));
    await this.Client.del(this.sessionKey(sessionId));

    if (raw) {
      const stored = JSON.parse(raw) as IStoredSession;
      await this.Client.srem(this.userKey(stored.UserId), sessionId);
    }
  }

  public async deleteByUser(userId: number): Promise<void> {
    const ids = await this.Client.smembers(this.userKey(userId));

    if (ids.length > 0) {
      await this.Client.del(...ids.map((id) => this.sessionKey(id)));
    }
    await this.Client.del(this.userKey(userId));
  }

  public async listByUser(userId: number): Promise<ISession[]> {
    const ids = await this.Client.smembers(this.userKey(userId));
    const sessions: ISession[] = [];

    for (const id of ids) {
      const raw = await this.Client.get(this.sessionKey(id));

      // key gone (TTL-evicted) or expired → prune the dead id from the set
      if (!raw) {
        await this.Client.srem(this.userKey(userId), id);
        continue;
      }

      const session = this.toSession(id, raw);
      if (this.isExpired(session)) {
        await this.delete(id);
        continue;
      }

      sessions.push(session);
    }

    return sessions;
  }

  public async truncate(): Promise<void> {
    // Prefix-scoped delete — only keys this store owns (session:* covers both the
    // session keys and the per-user index sets). Never a blind FLUSHDB.
    const prefix = this.Client.options.keyPrefix ?? '';
    const pattern = `${prefix}session:*`;

    let cursor = '0';
    do {
      const [next, keys] = await this.Client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;

      if (keys.length > 0) {
        // SCAN returns full keys (incl. the connection keyPrefix); strip it so the
        // client does not double-prefix on DEL.
        const stripped = keys.map((k) => (prefix && k.startsWith(prefix) ? k.slice(prefix.length) : k));
        await this.Client.del(...stripped);
      }
    } while (cursor !== '0');
  }

  protected sessionKey(sessionId: string): string {
    return `session:${sessionId}`;
  }

  protected userKey(userId: number): string {
    return `session:user:${userId}`;
  }

  protected toSession(sessionId: string, raw: string): ISession {
    const stored = JSON.parse(raw) as IStoredSession;

    return new UserSession({
      SessionId: sessionId,
      UserId: stored.UserId,
      Creation: DateTime.fromISO(stored.Creation),
      Expiration: stored.Expiration ? DateTime.fromISO(stored.Expiration) : undefined,
      Data: decodeSessionData(stored.Data),
    });
  }

  protected expirationEquals(a: DateTime | undefined, b: DateTime | undefined): boolean {
    if (a === undefined || b === undefined) {
      return a === b;
    }
    return a.toMillis() === b.toMillis();
  }
}
