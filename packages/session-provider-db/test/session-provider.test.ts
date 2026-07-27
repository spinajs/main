import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import _ from 'lodash';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI, Bootstrapper } from '@spinajs/di';
import '../src/index.js';
import { DbSessionStore } from '../src/index.js';
import { UserSession as Session } from '@spinajs/rbac';
import { DateTime } from 'luxon';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
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
            db: {
              cleanupInterval: 1000,
            },
            expiration: CURRENT_EXPIRATION,
          },
        },
        db: {
          DefaultConnection: 'sqlite',
          Connections: [
            {
              Driver: 'orm-driver-sqlite',
              Filename: ':memory:',
              Name: 'session-provider-connection',
              Migration: {
                OnStartup: true,
              },
            },
            {
              Driver: 'orm-driver-sqlite',
              Filename: ':memory:',
              Name: 'sqlite',
              Migration: {
                OnStartup: true,
              },
            },
          ],
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

async function boot() {
  DI.clearCache();

  // importing @spinajs/rbac registers ORM query middleware that depends on the
  // AccessControl instance provided by RbacBootstrapper — run bootstrappers as a
  // real app would before touching the Orm.
  const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
  for (const b of bootstrappers) {
    await b.bootstrap();
  }

  await DI.resolve(Configuration);
  await DI.resolve(Orm);
  return DI.resolve(DbSessionStore);
}

async function makeProvider(expiration: IConformanceExpiration) {
  CURRENT_EXPIRATION = expiration;
  return boot();
}

describe('db session provider', function () {
  this.timeout(15000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  // Full provider contract under multiple expiration strategies (E — reused kit).
  runSessionProviderConformance(makeProvider);

  describe('DbSessionStore regressions', () => {
    it('reads the correctly-spelled rbac.session.db.cleanupInterval config key (B2)', async () => {
      const store = await makeProvider({ service: 'SlidingExpiration', ttl: 60 });

      // The fixture sets cleanupInterval = 1000. With the historic typo
      // (`cleanupInteval`) the store would read nothing and fall back to the
      // 100000 default. Reading the configured value proves the key is fixed.
      expect((store as any).CleanupInterval).to.equal(1000);
    });

    it('save preserves an already-set Expiration exactly, under sliding mode (B3)', async () => {
      const store = await makeProvider({ service: 'SlidingExpiration', ttl: 60 });
      await store.truncate();

      const fixed = DateTime.fromISO('2031-05-06T07:08:09.000Z');
      const session = new Session({
        SessionId: 'b3-verbatim',
        UserId: 3,
        Expiration: fixed,
        Data: new Map<string, unknown>([['foo', 'bar']]),
      });

      await store.save(session);
      const restored = await store.restore('b3-verbatim');

      expect(restored).to.not.be.null;
      expect(restored!.Expiration!.toMillis()).to.equal(fixed.toMillis());
    });

    it('assigns an initial expiration only when a brand-new session has none', async () => {
      const store = await makeProvider({ service: 'SlidingExpiration', ttl: 60 });
      await store.truncate();

      const session = new Session({
        SessionId: 'b3-initial',
        UserId: 4,
        Expiration: undefined,
        Data: new Map<string, unknown>(),
      });

      await store.save(session);
      const restored = await store.restore('b3-initial');

      expect(restored).to.not.be.null;
      expect(restored!.Expiration, 'strategy should have scheduled an initial expiry').to.not.be.undefined;
      // sliding ttl = 60 minutes
      const diff = Math.abs(restored!.Expiration!.toMillis() - DateTime.now().plus({ minutes: 60 }).toMillis());
      expect(diff).to.be.lessThan(5000);
    });
  });
});
