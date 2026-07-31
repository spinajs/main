import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import _ from 'lodash';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI, Bootstrapper } from '@spinajs/di';
import '../src/index.js';
import { DbSessionStore } from '../src/index.js';
import { DbSession } from '../src/models/DbSession.js';
import { UserSession as Session, encodeSessionData, decodeSessionData } from '@spinajs/rbac';
import { DateTime } from 'luxon';
import { Orm } from '@spinajs/orm';
import { columnNativeType, isMySqlDialect } from '../src/migration-support.js';
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

    // Regression: the cleanup timer built its DELETE with
    // `DbSession.destroy().where(...)`, which throws "Cannot destroy without
    // primary keys" — so expired sessions piled up forever.
    it('cleanupExpired removes expired sessions and keeps live ones', async () => {
      const store = await makeProvider({ service: 'SlidingExpiration', ttl: 60 });
      await store.truncate();

      await store.save(
        new Session({
          SessionId: 'expired-one',
          UserId: 10,
          Expiration: DateTime.now().minus({ hours: 1 }),
          Data: new Map<string, unknown>(),
        }),
      );

      await store.save(
        new Session({
          SessionId: 'live-one',
          UserId: 11,
          Expiration: DateTime.now().plus({ hours: 1 }),
          Data: new Map<string, unknown>(),
        }),
      );

      const removed = await store.cleanupExpired();

      expect(removed).to.equal(1);
      expect(await DbSession.where({ SessionId: 'expired-one' }).first(), 'expired session must be gone').to.not.exist;
      expect(await DbSession.where({ SessionId: 'live-one' }).first(), 'live session must survive').to.exist;
    });

    it('cleanupExpired is a no-op when nothing expired', async () => {
      const store = await makeProvider({ service: 'SlidingExpiration', ttl: 60 });
      await store.truncate();

      expect(await store.cleanupExpired()).to.equal(0);
    });
  });

  // `user_sessions.Data` is a MySQL `json` column, and mysql2 hands a json column
  // back ALREADY PARSED - so the read path receives an object, not the string the
  // write path stored. sqlite (what these tests run on) has no json type and
  // returns the text, and so does any deployed database that has not yet run the
  // converging migration. Both shapes therefore reach `toSession` in the wild, and
  // both are pinned here.
  //
  // The failure this guards against is silent, not loud: the stored payload's top
  // level is the tagged wrapper `{ dataType: 'Map', value: [...] }`, so a decoder
  // that does not rebuild the tags returns an EMPTY session rather than raising -
  // every request looks authenticated-but-anonymous.
  describe('session Data: json column (object) and text column (string)', () => {
    const CREATED = DateTime.fromISO('2030-01-02T03:04:05.000Z');
    const EXPIRES = DateTime.fromISO('2030-01-02T04:04:05.000Z');

    // A Map-typed VALUE inside the session map: the reviver has to rebuild a tag
    // nested one level down, not just the top-level wrapper. A Set and a DateTime
    // ride along because they are the other two tagged types the codec emits.
    function payload() {
      return new Map<string, unknown>([
        ['User', '72beaf78-0000-4000-8000-000000000001'],
        ['TwoFactorPending', true],
        [
          'Preferences',
          new Map<string, unknown>([
            ['lang', 'pl'],
            ['perPage', 25],
          ]),
        ],
        ['Roles', new Set(['admin', 'user'])],
        ['Issued', CREATED],
      ]);
    }

    function row(data: unknown): DbSession {
      return {
        SessionId: 'representation-probe',
        UserId: 42,
        CreatedAt: CREATED,
        Expiration: EXPIRES,
        Data: data,
      } as unknown as DbSession;
    }

    function assertPayload(data: Map<string, unknown>, label: string) {
      expect(data, `${label}: must decode to a Map`).to.be.instanceOf(Map);
      expect(data.size, `${label}: entry count`).to.equal(5);
      expect(data.get('User'), `${label}: User`).to.equal('72beaf78-0000-4000-8000-000000000001');
      expect(data.get('TwoFactorPending'), `${label}: TwoFactorPending`).to.equal(true);

      const prefs = data.get('Preferences') as Map<string, unknown>;
      expect(prefs, `${label}: nested Map must survive as a Map`).to.be.instanceOf(Map);
      expect(prefs.get('lang')).to.equal('pl');
      expect(prefs.get('perPage')).to.equal(25);

      const roles = data.get('Roles') as Set<string>;
      expect(roles, `${label}: nested Set must survive as a Set`).to.be.instanceOf(Set);
      expect([...roles].sort()).to.deep.equal(['admin', 'user']);

      const issued = data.get('Issued') as DateTime;
      expect(DateTime.isDateTime(issued), `${label}: nested DateTime must survive as a DateTime`).to.equal(true);
      expect(issued.toMillis()).to.equal(CREATED.toMillis());
    }

    it('decodes an already-parsed object and the equivalent string to the identical session', async () => {
      const store = await makeProvider({ service: 'SlidingExpiration', ttl: 60 });

      const encoded = encodeSessionData(payload());

      // exactly what mysql2 does to a json column before the ORM ever sees it
      const asObject = JSON.parse(encoded) as unknown;
      expect(typeof asObject, 'the json-column representation must be an object, not a string').to.equal('object');

      const fromJsonColumn = (store as any).toSession(row(asObject));
      const fromTextColumn = (store as any).toSession(row(encoded));

      assertPayload(fromJsonColumn.Data, 'json column (object)');
      assertPayload(fromTextColumn.Data, 'text column (string)');

      // identical, entry for entry, not merely both non-empty
      expect([...fromJsonColumn.Data.keys()]).to.deep.equal([...fromTextColumn.Data.keys()]);
      expect(fromJsonColumn.SessionId).to.equal(fromTextColumn.SessionId);
      expect(fromJsonColumn.UserId).to.equal(fromTextColumn.UserId);
    });

    it('rebuilds the tagged payload from an object without going through JSON text', () => {
      // Handing the parsed object to the decoder untransformed used to yield
      // `new Map()` - the tag is an ordinary object, so `parsed instanceof Map`
      // was false and the empty-Map fallback swallowed the whole session.
      const decoded = decodeSessionData(JSON.parse(encodeSessionData(payload())));

      assertPayload(decoded, 'decodeSessionData(object)');
    });

    it('reads a Buffer-delivered payload (blob-ish column / binary driver mode)', async () => {
      const store = await makeProvider({ service: 'SlidingExpiration', ttl: 60 });
      const encoded = encodeSessionData(payload());

      const session = (store as any).toSession(row(Buffer.from(encoded, 'utf8')));

      // a Buffer walked as an object graph would decode to an empty session
      assertPayload(session.Data, 'buffer column');
    });

    // Both converging migrations run on EVERY startup of a database that has not
    // recorded them - including this sqlite one, where the table was just created
    // with the target types already. Both must survive that WITHOUT touching
    // anything: sqlite is not MySQL, has no `MODIFY` and no `JSON` type, and its
    // `Data` column is already declared `JSON` by the create path, so each one
    // has to return early on its own probe. Asserting they are recorded as
    // applied proves they were discovered, executed and did not throw - the
    // failure being guarded against is a throw here being recorded as a FAILED
    // migration, which makes `assertNoFailed()` block every future migration on
    // the connection.
    it('runs both converging migrations on startup without failing on a driver that cannot MODIFY', async () => {
      const store = await makeProvider({ service: 'SlidingExpiration', ttl: 60 });
      const driver = (store as any).Container?.get?.(Orm) ?? (await DI.resolve(Orm));

      const applied = (await driver.Connections.get('session-provider-connection').select().from('spinajs_migration')) as Array<{ Migration: string }>;
      const names = applied.map((r) => r.Migration);

      expect(names, 'create migration must be recorded').to.include('UserSessionDBSqlMigration_2022_06_28_01_20_00');
      expect(names, 'json converging migration must be recorded').to.include('UserSessionDataJson_2026_07_31_00_00_00');
      expect(names, 'timestamp converging migration must be recorded').to.include('UserSessionTimestamps_2026_07_31_00_00_01');
    });

    // The skip is the whole point of the probes, so it is asserted directly
    // rather than inferred from "nothing blew up". Each migration's guard is
    // evaluated against the live sqlite connection here, so a future edit that
    // makes either one fire on a non-MySQL driver fails loudly and locally
    // instead of at somebody's boot.
    it('both migrations resolve to SKIP on this sqlite connection', async () => {
      const store = await makeProvider({ service: 'SlidingExpiration', ttl: 60 });
      const orm = (store as any).Container?.get?.(Orm) ?? (await DI.resolve(Orm));
      const connection = orm.Connections.get('session-provider-connection');

      // guard 3, and on its own enough to skip both: `MODIFY` / `JSON` are MySQL's
      expect(isMySqlDialect(connection), 'sqlite must never be treated as MySQL').to.equal(false);

      // guard 2 of the JSON migration. sqlite's column compiler has no `json`
      // case at all, so `table.json('Data')` emits a column with NO type token
      // and PRAGMA table_info reports an empty type - which the probe reports as
      // "cannot establish the state", i.e. skip.
      expect(await columnNativeType(connection, 'user_sessions', 'Data'), 'unreadable Data type must skip, not guess').to.equal(null);

      // guard 2 of the timestamps migration: sqlite stores dateTime as TEXT,
      // which is not `date`, so there is nothing to widen.
      expect(await columnNativeType(connection, 'user_sessions', 'CreatedAt')).to.equal('text');
    });

    it('round-trips a saved session back out of the store with its structural types intact', async () => {
      const store = await makeProvider({ service: 'SlidingExpiration', ttl: 60 });
      await store.truncate();

      await store.save(
        new Session({
          SessionId: 'round-trip',
          UserId: 42,
          Expiration: EXPIRES,
          Data: payload(),
        }),
      );

      const restored = await store.restore('round-trip');

      expect(restored, 'session must come back').to.not.be.null;
      assertPayload(restored!.Data, 'write -> read round trip');
    });
  });
});
