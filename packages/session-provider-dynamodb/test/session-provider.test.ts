import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { randomUUID } from 'node:crypto';
import { UserSession as Session, decodeSessionData } from '@spinajs/authn-session';
import type { ISession } from '@spinajs/authn-session';
import { DateTime } from 'luxon';
import { DynamoDbSessionProvider } from '../src/index.js';
import { runSessionProviderConformance, IConformanceExpiration, SessionProviderFactory } from '../../authn-session/test/conformance/session-provider-conformance.js';
import { bootStore, disposeStore, fake, storedKeys, writeLegacyRow } from './support.js';
import type { LegacyRow } from './support.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const user = (id: string) => ({ type: 'user', id });
const SLIDING: IConformanceExpiration = { service: 'SlidingExpiration', ttl: 60 };
const ABSOLUTE: IConformanceExpiration = { service: 'AbsoluteExpiration', ttl: 60 };

async function makeProvider(expiration: IConformanceExpiration) {
  return bootStore({ expiration });
}

// The suite types the provider against authn-session's sources, the store against its build.
const conformanceFactory = makeProvider as unknown as SessionProviderFactory;

const session = (over: Partial<ISession>) => new Session({ Subject: user('u-1'), State: 'active', Expiration: DateTime.now().plus({ minutes: 10 }), Data: new Map<string, unknown>(), ...over });

const legacy = (over: Partial<LegacyRow> = {}) => {
  const creation = DateTime.now().minus({ minutes: 1 });
  return { rawId: randomUUID(), user: 'u-legacy', authorized: true, creation, expiration: creation.plus({ minutes: 30 }), ...over };
};

const item = (id: string) => fake.items.get(id)!;
const ids = (list: ISession[]) => list.map((s) => s.SessionId).sort();

/** Runs `between` once, right before the first `command` of the store reaches the table. */
function before(command: string, between: () => void): void {
  let done = false;
  fake.around = async (name, _input, run) => {
    if (name === command && !done) {
      done = true;
      between();
    }
    return run();
  };
}

describe('dynamodb session provider', function () {
  this.timeout(15000);

  after(async () => {
    await disposeStore();
  });

  runSessionProviderConformance(conformanceFactory, {
    seedLegacy: async (provider, row) => writeLegacyRow(provider as unknown as DynamoDbSessionProvider, row),
  });

  describe('DynamoDbSessionProvider regressions', () => {
    it("deleteBySubject removes only the target subject's sessions, matched on the Subject attribute (B4)", async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();

      await store.save(session({ SessionId: 'b4-user1', Subject: user('1'), Data: new Map<string, unknown>([['User', 'uuid-1']]) }));
      await store.save(session({ SessionId: 'b4-user2', Subject: user('2'), Data: new Map<string, unknown>([['User', 'uuid-2']]) }));

      await store.deleteBySubject(user('1'));

      expect(await store.restore('b4-user1'), 'u1 session should be gone').to.be.null;
      expect(await store.restore('b4-user2'), 'u2 session must survive').to.not.be.null;
    });
  });

  describe('touch (one conditional UpdateItem)', () => {
    it('SR-07 touch with an active view never extends a row stored as pending', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();

      const fixed = DateTime.now().plus({ minutes: 5 });
      await store.save(session({ SessionId: 't-pending', State: 'pending', Expiration: fixed }));

      const forged = session({ SessionId: 't-pending', State: 'active', Expiration: fixed });
      forged.Data.set('authn:facts', 'forged');
      expect(await store.touch(forged)).to.be.false;
      expect(forged.Expiration!.toMillis(), "the caller's view keeps its expiration").to.equal(fixed.toMillis());

      const after = (await store.restore('t-pending'))!;
      expect(after.State).to.equal('pending');
      expect(after.Expiration!.toMillis()).to.equal(fixed.toMillis());
      expect(after.Data.has('authn:facts'), 'nothing of the forged view is written').to.be.false;
    });

    it('SR-07 touch with an active view never extends a 2.x item that never passed 2FA', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();

      const row = legacy({ authorized: false });
      await writeLegacyRow(store, row);

      const forged = session({ SessionId: row.rawId, Subject: user(row.user), State: 'active', Expiration: row.expiration });
      forged.Data.set('Authorized', true);
      expect(await store.touch(forged)).to.be.false;
      const after = (await store.restore(row.rawId))!;
      expect(after.State).to.equal('pending');
      expect(after.Expiration!.toMillis()).to.equal(row.expiration.toMillis());
    });

    it('touch writes nothing to a 2.x item, whatever view it gets (the issuer migrates 2.x rows before any write)', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();

      const row = legacy({ user: 'u-2x', impersonator: 'admin' });
      await writeLegacyRow(store, row);
      const before = JSON.stringify(item(row.rawId));
      const restored = (await store.restore(row.rawId))!;
      restored.Data.set('User', 'someone-else');
      restored.Data.delete('Impersonator');

      expect(await store.touch(restored)).to.be.false;
      expect(JSON.stringify(item(row.rawId))).to.equal(before);
      expect(ids(await store.listBySubject(user('admin'), { includeImpersonations: true }))).to.deep.equal([row.rawId]);
    });

    it("touch never changes the stored Subject, ImpersonatorId or State, whatever the caller's view says", async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();

      await store.save(session({ SessionId: 't-identity', Subject: user('victim'), Impersonator: user('admin') }));
      const view = (await store.restore('t-identity'))!;
      view.Subject = user('other');
      view.Impersonator = undefined;

      expect(await store.touch(view)).to.be.true;
      expect(item('t-identity').Subject).to.deep.equal({ S: 'user:victim' });
      expect(item('t-identity').ImpersonatorId).to.deep.equal({ S: 'user:admin' });
      expect(item('t-identity').State).to.deep.equal({ S: 'active' });
    });

    it('touch writes the renewed Expiration as epoch ms, the TTL attribute', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();

      await store.save(session({ SessionId: 't-ttl', Expiration: DateTime.now().plus({ seconds: 30 }) }));
      const view = (await store.restore('t-ttl'))!;
      expect(await store.touch(view)).to.be.true;

      expect(item('t-ttl').Expiration).to.deep.equal({ N: `${view.Expiration!.toMillis()}` });
      expect(Number(item('t-ttl').Expiration.N)).to.be.greaterThan(DateTime.now().plus({ minutes: 59 }).toMillis());
    });

    it('touch keeps a never-expiring row never-expiring and still writes its Data', async () => {
      const store = await makeProvider(ABSOLUTE);
      await store.truncate();

      await store.save(session({ SessionId: 't-forever' }));
      delete fake.items.get('t-forever')!.Expiration;
      const view = (await store.restore('t-forever'))!;
      expect(view.Expiration).to.equal(undefined);
      view.Data.set('Ip', '203.0.113.4');

      expect(await store.touch(view)).to.be.false;
      expect(item('t-forever')).to.not.have.property('Expiration');
      expect(decodeSessionData(item('t-forever').Data.S).get('Ip')).to.equal('203.0.113.4');
    });

    it('SR-session idle timeout: touch never extends a row whose Expiration passed while DynamoDB still holds the item', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();

      await store.save(session({ SessionId: 't-lapsed', Expiration: DateTime.now().plus({ hours: 1 }) }));
      const view = (await store.restore('t-lapsed'))!;
      item('t-lapsed').Expiration = { N: `${DateTime.now().minus({ seconds: 1 }).toMillis()}` };

      expect(await store.touch(view)).to.be.false;
      expect(await store.restore('t-lapsed')).to.be.null;
    });

    it('SR-session revocation: touch never re-creates a row deleted between the caller reading it and the write', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();

      await store.save(session({ SessionId: 't-race-del', Expiration: DateTime.now().plus({ seconds: 30 }) }));
      const view = (await store.restore('t-race-del'))!;
      before('UpdateItemCommand', () => fake.items.delete('t-race-del'));

      expect(await store.touch(view)).to.be.false;
      expect(fake.items.has('t-race-del'), 'a logout before the write stays in force').to.be.false;
    });

    it('SR-07 touch never extends a row that turned pending between the caller reading it and the write', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();

      const fixed = DateTime.now().plus({ seconds: 30 });
      await store.save(session({ SessionId: 't-race-state', Expiration: fixed }));
      const view = (await store.restore('t-race-state'))!;
      before('UpdateItemCommand', () => {
        item('t-race-state').State = { S: 'pending' };
      });

      expect(await store.touch(view)).to.be.false;
      expect((await store.restore('t-race-state'))!.Expiration!.toMillis()).to.equal(fixed.toMillis());
    });
  });

  describe('deleteBySubject / listBySubject (consistent Scan)', () => {
    it('SR-session revocation: deleteBySubject also ends a row saved for the subject while it runs (rotation racing a ban)', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();
      await store.save(session({ SessionId: 'd-old', Subject: user('banned') }));

      let scans = 0;
      fake.around = async (name, _input, run) => {
        const result = await run();
        if (name === 'ScanCommand' && scans++ === 0) {
          fake.items.set('d-rotated', { ...item('d-old'), SessionId: { S: 'd-rotated' } });
        }
        return result;
      };

      expect(await store.deleteBySubject(user('banned'))).to.equal(2);
      expect(fake.items.has('d-rotated')).to.be.false;
    });

    it('deleteBySubject does not count an item that a concurrent logout deleted first', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();
      await store.save(session({ SessionId: 'd-gone', Subject: user('raced') }));
      before('DeleteItemCommand', () => fake.items.delete('d-gone'));

      expect(await store.deleteBySubject(user('raced'))).to.equal(0);
    });

    it('pages through the whole table', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();
      fake.pageSize = 1;

      for (let i = 0; i < 5; i++) {
        await store.save(session({ SessionId: `p-own-${i}`, Subject: user('paged') }));
        await store.save(session({ SessionId: `p-other-${i}`, Subject: user('other') }));
      }

      expect(ids(await store.listBySubject(user('paged')))).to.have.length(5);
      expect(await store.deleteBySubject(user('paged'))).to.equal(5);
      expect((await storedKeys(store)).sort()).to.deep.equal([0, 1, 2, 3, 4].map((i) => `p-other-${i}`));
    });

    it('deleteBySubject also removes the expired rows of the subject, counting only the live ones', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();

      await store.save(session({ SessionId: 'e-live', Subject: user('e') }));
      await store.save(session({ SessionId: 'e-dead', Subject: user('e'), Expiration: DateTime.now().minus({ minutes: 1 }) }));

      expect(await store.deleteBySubject(user('e'))).to.equal(1);
      expect(await storedKeys(store)).to.deep.equal([]);
    });

    it('SR-session revocation: every read is strongly consistent, so a delete is seen at once', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();
      await store.save(session({ SessionId: 'c-1', Subject: user('c') }));
      fake.sent.length = 0;

      await store.restore('c-1');
      await store.listBySubject(user('c'), { includeImpersonations: true });
      await store.deleteBySubject(user('c'));
      await store.truncate();

      const reads = fake.sent.filter((s) => s.command === 'GetItemCommand' || s.command === 'ScanCommand');
      expect(reads.length).to.be.greaterThan(3);
      for (const read of reads) {
        expect(read.input.ConsistentRead, `${read.command} reads consistently`).to.equal(true);
      }
    });

    it('one undecodable item fails neither listBySubject nor deleteBySubject for others', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();
      const creation = { S: DateTime.now().toISO()! };
      fake.items.set('bad-json', { SessionId: { S: 'bad-json' }, UserId: { N: '1' }, Creation: creation, Data: { S: '{not json' } });
      fake.items.set('no-data', { SessionId: { S: 'no-data' }, UserId: { N: '1' }, Creation: creation });
      const good = legacy({ user: 'u-good' });
      await writeLegacyRow(store, good);

      expect(ids(await store.listBySubject(user('u-good')))).to.deep.equal([good.rawId]);
      expect(await store.deleteBySubject(user('u-good'))).to.equal(1);
    });

    it('a 3.0 item whose Data does not decode keeps the owner its own attributes give', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();
      await store.save(session({ SessionId: 'bad-data', Subject: user('u-bad') }));
      item('bad-data').Data = { S: '{not json' };

      const listed = await store.listBySubject(user('u-bad'));
      expect(ids(listed)).to.deep.equal(['bad-data']);
      expect(listed[0].Data.size).to.equal(0);
      expect(await store.deleteBySubject(user('u-bad'))).to.equal(1);
    });

    it('an Expiration that is not a number counts as passed', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();
      await store.save(session({ SessionId: 'bad-exp', Subject: user('u-exp') }));
      item('bad-exp').Expiration = { S: 'tomorrow' };

      expect(await store.restore('bad-exp')).to.be.null;
      expect(await store.listBySubject(user('u-exp'))).to.deep.equal([]);
    });

    it('a 2.x item is matched by the User in its Data, never by its numeric UserId', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();
      const row = legacy({ user: 'uuid-of-7' });
      await writeLegacyRow(store, row);
      expect(item(row.rawId).UserId).to.deep.equal({ N: '1' });

      expect(await store.deleteBySubject(user('1'))).to.equal(0);
      expect(await store.deleteBySubject(user('uuid-of-7'))).to.equal(1);
    });
  });
});
