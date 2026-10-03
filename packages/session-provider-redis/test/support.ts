import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { SessionIssuer } from '@spinajs/authn/contracts';
import { AbsoluteExpiration, DefaultSessionIssuer, SessionExpirationProvider, SessionProvider, SlidingCappedExpiration, SlidingExpiration, encodeSessionData } from '@spinajs/authn-session';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import _ from 'lodash';
import { DateTime } from 'luxon';
import { RedisSessionStore } from '../src/index.js';

let sessionOverrides: Record<string, unknown> = {};

export class RedisSessionTestConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.merge(this.Config, {
      authn: {
        session: {
          service: 'RedisSessionStore',
          expiration: { service: 'SlidingExpiration', ttl: 60 },
          redis: {},
        },
      },
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
    });
    _.merge(this.Config, { authn: { session: sessionOverrides } });
  }
}

// ioredis-mock instances share one keyspace per host:port, so the store's client and rawClient() see the same keys.
(RedisSessionStore.prototype as unknown as { createClient: (this: RedisSessionStore) => Redis }).createClient = function () {
  return new RedisMock((this as unknown as { RedisConfig: object }).RedisConfig ?? {}) as unknown as Redis;
};

/** Types these tests resolve; uncached between boots instead of a blanket DI.clearCache(). */
const OWNED_TYPES: unknown[] = [Configuration, RedisSessionTestConfiguration, SessionProvider, RedisSessionStore, SessionExpirationProvider, AbsoluteExpiration, SlidingExpiration, SlidingCappedExpiration, DefaultSessionIssuer, SessionIssuer];

let registered = false;
let current: RedisSessionStore | undefined;

async function shutdown(): Promise<void> {
  if (current) {
    await current.dispose();
    current = undefined;
  }
  for (const t of OWNED_TYPES) {
    DI.uncache(t as never);
  }
}

/** The store over the shared ioredis-mock keyspace; `session` is merged over `authn.session`. */
export async function bootStore(session: Record<string, unknown> = {}): Promise<RedisSessionStore> {
  await shutdown();
  if (!registered) {
    // The configuration loader reads every @spinajs package's config; without this it tries their CommonJS builds.
    DI.setESMModuleSupport();
    DI.register(RedisSessionTestConfiguration).as(Configuration);
    registered = true;
  }

  sessionOverrides = session;
  await DI.resolve(Configuration);
  current = await DI.resolve(RedisSessionStore);
  return current;
}

export const disposeStore = shutdown;

/** A client without key prefix over the same keyspace, to read and write keys as they are stored. */
export const rawClient = (): Redis => new RedisMock() as unknown as Redis;

/** A row as the 2.x store wrote it: raw uuid key, numeric UserId, identity only in Data, the id in `session:user:<UserId>`. */
export interface LegacyRow {
  rawId: string;
  user?: string;
  authorized: boolean;
  impersonator?: string;
  creation: DateTime;
  expiration?: DateTime;
}

export async function writeLegacyRow(row: LegacyRow, keyPrefix = ''): Promise<void> {
  const data = new Map<string, unknown>([['Logged', true]]);
  if (row.user !== undefined) data.set('User', row.user);
  data.set('Authorized', row.authorized);
  if (row.impersonator) data.set('Impersonator', row.impersonator);

  const client = rawClient();
  const key = `${keyPrefix}session:${row.rawId}`;
  await client.set(key, JSON.stringify({ UserId: 1, Creation: row.creation.toISO(), Expiration: row.expiration?.toISO(), Data: encodeSessionData(data) }));
  if (row.expiration) {
    await client.pexpireat(key, row.expiration.toMillis());
  }
  await client.sadd(`${keyPrefix}session:user:1`, row.rawId);
}

/** A 2.x row that was there when this node booted: written as 2.x did, then indexed by the boot sweep. */
export async function seedLegacyRow(store: RedisSessionStore, row: LegacyRow): Promise<void> {
  await writeLegacyRow(row);
  await store.sweepLegacy();
}

/** Every session key in the keyspace (index sets left out), live or not yet evicted. */
export async function storedKeys(): Promise<string[]> {
  const client = rawClient();
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await client.scan(cursor, 'MATCH', 'session:*', 'COUNT', 100);
    cursor = next;
    keys.push(...batch.map((k) => k.slice('session:'.length)).filter((id) => !id.includes(':')));
  } while (cursor !== '0');
  return keys;
}
