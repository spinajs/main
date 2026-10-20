import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DbSession } from '../src/models/DbSession.js';
import { UserSession as Session, encodeSessionData, decodeSessionData } from '@spinajs/authn-session';
import type { ISession } from '@spinajs/authn-session';
import { DateTime } from 'luxon';
import { runSessionProviderConformance, IConformanceExpiration, SessionProviderFactory } from '../../authn-session/test/conformance/session-provider-conformance.js';
import { bootStore, disposeStore, sessionConnection } from './support.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const user = (id: string) => ({ type: 'user', id });

async function makeProvider(expiration: IConformanceExpiration) {
  return bootStore({ expiration });
}

// The suite types the provider against authn-session's sources, the store against its build.
const conformanceFactory = makeProvider as unknown as SessionProviderFactory;

describe('db session provider', function () {
  this.timeout(15000);

  after(async () => {
    await disposeStore();
  });

  runSessionProviderConformance(conformanceFactory);

  describe('DbSessionStore regressions', () => {
    it('reads the correctly-spelled authn.session.db.cleanupInterval config key (B2)', async () => {
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
        Subject: user('u-3'),
        State: 'active',
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
        Subject: user('u-4'),
        State: 'active',
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

    // Regression: the cleanup timer's DELETE once threw before reaching the
    // database, so expired sessions piled up forever.
    it('cleanupExpired removes expired sessions and keeps live ones', async () => {
      const store = await makeProvider({ service: 'SlidingExpiration', ttl: 60 });
      await store.truncate();

      await store.save(
        new Session({
          SessionId: 'expired-one',
          Subject: user('u-10'),
          State: 'active',
          Expiration: DateTime.now().minus({ hours: 1 }),
          Data: new Map<string, unknown>(),
        }),
      );

      await store.save(
        new Session({
          SessionId: 'live-one',
          Subject: user('u-11'),
          State: 'active',
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

  describe('3.0 columns', () => {
    it('stores Subject, ImpersonatorId and State in their own columns as principal keys', async () => {
      const store = await makeProvider({ service: 'SlidingExpiration', ttl: 60 });
      await store.truncate();

      await store.save(new Session({ SessionId: 'k-cols', Subject: user('u-1'), Impersonator: { type: 'svc:ops', id: 'a:b' }, State: 'active', Data: new Map() }));
      const row = (await DbSession.where({ SessionId: 'k-cols' }).first()) as DbSession;

      expect(row.Subject).to.equal('user:u-1');
      expect(row.ImpersonatorId).to.equal('svc%3Aops:a:b');
      expect(row.State).to.equal('active');
      expect(row.UserId ?? null, 'a 3.0 row has no numeric owner').to.equal(null);

      const back = (await store.restore('k-cols'))!;
      expect({ ...back.Impersonator }).to.deep.equal({ type: 'svc:ops', id: 'a:b' });
    });

    it('SR-07 a stored State other than active comes back pending (fail closed)', async () => {
      const store = await makeProvider({ service: 'SlidingExpiration', ttl: 60 });
      await store.truncate();

      await store.save(new Session({ SessionId: 'k-odd', Subject: user('u-1'), State: 'active', Data: new Map() }));
      await DbSession.update({ State: 'Active' } as Partial<DbSession>).where('SessionId', 'k-odd');

      expect((await store.restore('k-odd'))!.State).to.equal('pending');
    });

    it('SR-07 touch with an active view never extends a row stored as pending', async () => {
      const store = await makeProvider({ service: 'SlidingExpiration', ttl: 60 });
      await store.truncate();

      const fixed = DateTime.now().plus({ minutes: 5 });
      await store.save(new Session({ SessionId: 'k-pending', Subject: user('u-1'), State: 'pending', Expiration: fixed, Data: new Map() }));
      const forged = new Session({ SessionId: 'k-pending', Subject: user('u-1'), State: 'active', Expiration: fixed, Data: new Map() });

      expect(await store.touch(forged)).to.be.false;
      const after = (await store.restore('k-pending'))!;
      expect(after.State).to.equal('pending');
      expect(after.Expiration!.toMillis()).to.equal(fixed.toMillis());
    });

    it('deleteBySubject counts only live rows, and also deletes the expired ones', async () => {
      const store = await makeProvider({ service: 'SlidingExpiration', ttl: 60 });
      await store.truncate();

      await store.save(new Session({ SessionId: 'k-live', Subject: user('u-1'), State: 'active', Data: new Map() }));
      await store.save(new Session({ SessionId: 'k-dead', Subject: user('u-1'), State: 'active', Expiration: DateTime.now().minus({ minutes: 1 }), Data: new Map() }));

      expect(await store.deleteBySubject(user('u-1'))).to.equal(1);
      expect(await DbSession.where({ SessionId: 'k-dead' }).first()).to.not.exist;
    });

    it('one row whose Data does not decode cannot make revocation throw for everybody', async () => {
      const store = await makeProvider({ service: 'SlidingExpiration', ttl: 60 });
      await store.truncate();

      const conn = await sessionConnection();
      const exp = DateTime.now().plus({ minutes: 10 });
      await conn.insert().into('user_sessions').values({ SessionId: 'k-corrupt', CreatedAt: DateTime.now(), Expiration: exp, Data: '{not json', Subject: 'user:u-1', State: 'active' });
      await store.save(new Session({ SessionId: 'k-other', Subject: user('u-2'), State: 'active', Data: new Map() }));

      expect(await store.deleteBySubject(user('u-2'))).to.equal(1);
      expect(await store.deleteBySubject(user('u-1')), "the subject's own undecodable row is still revoked").to.equal(1);
      expect(await DbSession.where({ SessionId: 'k-corrupt' }).first()).to.not.exist;
    });

    it('SR-session revocation: touch never extends a row that has already expired', async () => {
      const store = await makeProvider({ service: 'SlidingExpiration', ttl: 60 });
      await store.truncate();

      const past = DateTime.now().minus({ seconds: 1 });
      await store.save(new Session({ SessionId: 'k-expired', Subject: user('u-1'), State: 'active', Expiration: past, Data: new Map() }));
      const view = new Session({ SessionId: 'k-expired', Subject: user('u-1'), State: 'active', Expiration: past, Data: new Map() });

      expect(await store.touch(view)).to.be.false;
      expect(await store.restore('k-expired')).to.be.null;
    });
  });

  // `user_sessions.Data` is a MySQL `json` column, and mysql2 hands a json column
  // back ALREADY PARSED - so the read path receives an object, not the string the
  // write path stored. sqlite (what these tests run on) has no json type and
  // returns the text. Both shapes therefore reach `toSession` in the wild, and
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
        ['Owner', '72beaf78-0000-4000-8000-000000000001'],
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
        Subject: 'user:72beaf78-0000-4000-8000-000000000001',
        ImpersonatorId: null,
        State: 'active',
        UserId: null,
        CreatedAt: CREATED,
        Expiration: EXPIRES,
        Data: data,
      } as unknown as DbSession;
    }

    function assertPayload(data: Map<string, unknown>, label: string) {
      expect(data, `${label}: must decode to a Map`).to.be.instanceOf(Map);
      expect(data.size, `${label}: entry count`).to.equal(5);
      expect(data.get('Owner'), `${label}: Owner`).to.equal('72beaf78-0000-4000-8000-000000000001');
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

      const fromJsonColumn = (store as any).toSession(row(asObject)) as ISession;
      const fromTextColumn = (store as any).toSession(row(encoded)) as ISession;

      assertPayload(fromJsonColumn.Data, 'json column (object)');
      assertPayload(fromTextColumn.Data, 'text column (string)');

      // identical, entry for entry, not merely both non-empty
      expect([...fromJsonColumn.Data.keys()]).to.deep.equal([...fromTextColumn.Data.keys()]);
      expect(fromJsonColumn.SessionId).to.equal(fromTextColumn.SessionId);
      expect({ ...fromJsonColumn.Subject }).to.deep.equal({ ...fromTextColumn.Subject });
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

    it('records the create migration on startup', async () => {
      await makeProvider({ service: 'SlidingExpiration', ttl: 60 });
      const connection = await sessionConnection();

      const applied = (await connection.select().from('spinajs_migration')) as Array<{ Migration: string }>;
      expect(applied.map((r) => r.Migration)).to.include('UserSessionDBSqlMigration_2022_06_28_01_20_00');
    });

    it('round-trips a saved session back out of the store with its structural types intact', async () => {
      const store = await makeProvider({ service: 'SlidingExpiration', ttl: 60 });
      await store.truncate();

      await store.save(
        new Session({
          SessionId: 'round-trip',
          Subject: user('u-42'),
          State: 'active',
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
