import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import _ from 'lodash';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import RedisMock from 'ioredis-mock';
import '../src/index.js';
import { RedisSessionStore } from '../src/index.js';
import { UserSession as Session } from '@spinajs/rbac';
import { DateTime } from 'luxon';
import { runSessionProviderConformance, IConformanceExpiration } from '../../rbac/test/conformance/session-provider-conformance.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

// Current expiration strategy config the ConnectionConf will publish. The
// conformance factory swaps this per strategy before (re)resolving DI.
let CURRENT_EXPIRATION: IConformanceExpiration = { service: 'SlidingExpiration', ttl: 60 };

export function mergeArrays(target: any, source: any) {
  if (_.isArray(target)) {
    return target.concat(source);
  }
}

export class ConnectionConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        rbac: {
          session: {
            // connection opts are irrelevant — the test injects an ioredis-mock
            // client and stubs resolve() so no real connection is opened.
            redis: {},
            expiration: CURRENT_EXPIRATION,
          },
        },
        logger: {
          targets: [
            {
              name: 'Empty',
              type: 'BlackHoleTarget',
              layout: '${datetime} ${level} ${message} ${error} duration: ${duration} (${logger})',
            },
          ],

          rules: [{ name: '*', level: 'trace', target: 'Empty' }],
        },
      },
      mergeArrays,
    );
  }
}

/**
 * Builds a `RedisSessionStore` bound to the given expiration strategy, backed by
 * a stateful `ioredis-mock` client. `resolve()` (which would open a real ioredis
 * connection) is stubbed out; the fake client is injected instead — mirroring how
 * the dynamodb provider injects its in-memory fake.
 */
async function makeProvider(expiration: IConformanceExpiration) {
  CURRENT_EXPIRATION = expiration;

  DI.clearCache();
  DI.register(ConnectionConf).as(Configuration);
  await DI.resolve(Configuration);

  const orig = RedisSessionStore.prototype.resolve;
  RedisSessionStore.prototype.resolve = async function () {};
  const provider = await DI.resolve(RedisSessionStore);
  RedisSessionStore.prototype.resolve = orig;

  (provider as any).Client = new RedisMock();

  return provider;
}

describe('redis session provider', function () {
  this.timeout(15000);

  // Full provider contract under sliding / absolute / capped strategies (E — reused kit).
  runSessionProviderConformance(makeProvider);

  describe('RedisSessionStore regressions', () => {
    it('deleteByUser removes only the target user\'s sessions across multiple users', async () => {
      const store = await makeProvider({ service: 'SlidingExpiration', ttl: 60 });
      await store.truncate();

      const u1a = new Session({ SessionId: 'r-u1-a', UserId: 1, Expiration: DateTime.now().plus({ minutes: 10 }), Data: new Map() });
      const u1b = new Session({ SessionId: 'r-u1-b', UserId: 1, Expiration: DateTime.now().plus({ minutes: 10 }), Data: new Map() });
      const u2 = new Session({ SessionId: 'r-u2', UserId: 2, Expiration: DateTime.now().plus({ minutes: 10 }), Data: new Map() });

      await store.save(u1a);
      await store.save(u1b);
      await store.save(u2);

      await store.deleteByUser(1);

      expect(await store.restore('r-u1-a'), 'u1 session a gone').to.be.null;
      expect(await store.restore('r-u1-b'), 'u1 session b gone').to.be.null;
      expect(await store.restore('r-u2'), 'u2 session survives').to.not.be.null;
    });

    it('listByUser returns live sessions and prunes expired ids from the user set', async () => {
      const store = await makeProvider({ service: 'SlidingExpiration', ttl: 60 });
      await store.truncate();

      const live = new Session({ SessionId: 'r-live', UserId: 9, Expiration: DateTime.now().plus({ minutes: 10 }), Data: new Map() });
      const expired = new Session({ SessionId: 'r-expired', UserId: 9, Expiration: DateTime.now().plus({ minutes: 10 }), Data: new Map() });

      await store.save(live);
      await store.save(expired);

      // Force `r-expired` to carry a past Expiration in-store while its id stays
      // in the user set (simulates the physical key lingering).
      const client = (store as any).Client;
      const key = 'session:r-expired';
      const raw = JSON.parse(await client.get(key));
      raw.Expiration = DateTime.now().minus({ minutes: 5 }).toISO();
      await client.set(key, JSON.stringify(raw));

      const list = await store.listByUser(9);
      expect(list.map((s) => s.SessionId)).to.deep.equal(['r-live']);

      // the expired id must have been pruned from the user index set
      const members: string[] = await client.smembers('session:user:9');
      expect(members).to.deep.equal(['r-live']);
    });

    it('save persists an already-set Expiration verbatim', async () => {
      const store = await makeProvider({ service: 'SlidingExpiration', ttl: 60 });
      await store.truncate();

      const fixed = DateTime.fromISO('2031-05-06T07:08:09.000Z');
      const s = new Session({ SessionId: 'r-verbatim', UserId: 3, Expiration: fixed, Data: new Map() });

      await store.save(s);
      const restored = await store.restore('r-verbatim');

      expect(restored).to.not.be.null;
      expect(restored!.Expiration!.toMillis()).to.equal(fixed.toMillis());
    });

    it('restore returns null for an expired session even if the mock kept the key', async () => {
      const store = await makeProvider({ service: 'SlidingExpiration', ttl: 60 });
      await store.truncate();

      // Save with a future expiry so the physical key is retained, then flip the
      // stored Expiration to the past WITHOUT a Redis TTL. `restore` must still
      // gate on `isExpired` and report null.
      const s = new Session({ SessionId: 'r-ghost', UserId: 4, Expiration: DateTime.now().plus({ hours: 1 }), Data: new Map() });
      await store.save(s);

      const client = (store as any).Client;
      const key = 'session:r-ghost';
      const raw = JSON.parse(await client.get(key));
      raw.Expiration = DateTime.now().minus({ hours: 1 }).toISO();
      await client.set(key, JSON.stringify(raw));

      expect(await client.get(key), 'mock still holds the key').to.not.be.null;
      expect(await store.restore('r-ghost'), 'expired session reads as absent').to.be.null;
    });
  });
});
