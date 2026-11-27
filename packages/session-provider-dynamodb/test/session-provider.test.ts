import { createHash } from 'crypto';
import { inspect } from 'util';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { UserSession as Session, decodeSessionData } from '@spinajs/authn-session';
import type { ISession } from '@spinajs/authn-session';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log';
import { DateTime } from 'luxon';
import type { DynamoDbSessionProvider } from '../src/index.js';
import { runSessionProviderConformance, IConformanceExpiration, SessionProviderFactory } from '../../authn-session/test/conformance/session-provider-conformance.js';
import { bootStore, disposeStore, fake, storedKeys } from './support.js';

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

  runSessionProviderConformance(conformanceFactory);

  describe('DynamoDbSessionProvider regressions', () => {
    it("deleteBySubject removes only the target subject's sessions, matched on the Subject attribute (B4)", async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();

      await store.save(session({ SessionId: 'b4-user1', Subject: user('1') }));
      await store.save(session({ SessionId: 'b4-user2', Subject: user('2') }));

      await store.deleteBySubject(user('1'));

      expect(await store.restore('b4-user1'), 'u1 session should be gone').to.be.null;
      expect(await store.restore('b4-user2'), 'u2 session must survive').to.not.be.null;
    });

    /** An impersonated session from IdP session ek-1, with one attribute rewritten after the caller read it (undefined removes it). */
    async function savedWith(store: DynamoDbSessionProvider, id: string, attribute: string, value: AttributeValue | undefined): Promise<ISession> {
      await store.save(session({ SessionId: id, Subject: user('u-42'), Impersonator: user('admin'), ExternalKey: 'ek-1' }));
      const view = (await store.restore(id))!;
      if (value === undefined) {
        delete item(id)[attribute];
      } else {
        item(id)[attribute] = value;
      }
      return view;
    }

    const REVOCATIONS: [attribute: string, readable: AttributeValue, revoke: (store: DynamoDbSessionProvider) => Promise<number>, unreadable: [string, AttributeValue][]][] = [
      [
        'ImpersonatorId',
        { S: 'user:admin' },
        (store) => store.deleteBySubject(user('admin'), { includeImpersonations: true }),
        [['empty text', { S: '' }], ['text without a type', { S: 'admin' }], ['an empty type', { S: ':admin' }], ['an empty id', { S: 'user:' }], ['a number', { N: '0' }], ['null', { NULL: true }], ['a boolean', { BOOL: false }], ['a map', { M: {} }], ['a list', { L: [] }]],
      ],
      ['ExternalKey', { S: 'ek-1' }, (store) => store.deleteByExternalKey('ek-1'), [['a number', { N: '1' }], ['null', { NULL: true }], ['a boolean', { BOOL: true }], ['a map', { M: {} }], ['a list', { L: [] }]]],
    ];

    for (const [attribute, readable, revoke, unreadable] of REVOCATIONS) {
      it(`a present but unreadable ${attribute} ends the session, so the revocation that cannot find it leaves nothing usable`, async () => {
        const store = await makeProvider(SLIDING);
        await store.truncate();

        for (const [label, value] of [['readable', readable], ['absent', undefined], ...unreadable] as [string, AttributeValue | undefined][]) {
          const id = `r-${attribute}-${label.replace(/\W+/g, '-')}`;
          const view = await savedWith(store, id, attribute, value);
          const stored = item(id).Expiration;

          expect(await revoke(store), `${label}: revoked and counted`).to.equal(value === readable ? 1 : 0);
          const restored = await store.restore(id);
          if (value === undefined) {
            expect(restored, `${label}: untouched by the revocation`).to.not.be.null;
          } else {
            expect(restored, label).to.equal(null);
            expect(await store.touch(view), `${label}: touch`).to.be.false;
          }
          if (value !== undefined && value !== readable) {
            expect(item(id).Expiration, `${label}: not extended`).to.deep.equal(stored);
          }

          const listed = `${id}-listed`;
          await savedWith(store, listed, attribute, value);
          expect(ids(await store.listBySubject(user('u-42'))).includes(listed), `${label}: listed`).to.equal(value === readable || value === undefined);
          await store.delete(listed);
        }

        expect(await store.deleteBySubject(user('u-42')), 'the subject revocation counts only the absent one').to.equal(1);
        expect(await storedKeys(store), 'and deletes every unreadable one').to.deep.equal([]);
      });
    }

    it('a Subject with an empty id is unreadable like any other, not the principal user:""', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();
      await store.save(session({ SessionId: 'r-subject-empty-id', Subject: user('u-42') }));
      item('r-subject-empty-id').Subject = { S: 'user:' };

      expect(await store.restore('r-subject-empty-id')).to.equal(null);
      expect(await store.listBySubject(user(''))).to.deep.equal([]);
    });

    it('an ExternalKey that is the empty string is a key like any other', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();
      await store.save(session({ SessionId: 'r-ext-empty', Subject: user('u-42'), ExternalKey: '' }));

      expect((await store.restore('r-ext-empty'))?.ExternalKey).to.equal('');
      expect(await store.deleteByExternalKey('')).to.equal(1);
    });

    it('an unreadable ImpersonatorId or ExternalKey is logged once per read, naming the subject and the attribute and never the session id', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();
      const log = DI.resolve(Log, ['dynamo-session-store']);
      expect(Object.hasOwn(log, 'warn'), 'warn comes from the prototype, so deleting the stub restores it').to.equal(false);

      for (const attribute of ['ImpersonatorId', 'ExternalKey']) {
        const id = `r-warn-${attribute}-bearer-key`;
        await savedWith(store, id, attribute, { N: '0' });
        const lines: string[] = [];
        log.warn = (first: unknown) => {
          lines.push(String(first));
        };
        try {
          expect(await store.restore(id)).to.equal(null);
        } finally {
          Reflect.deleteProperty(log, 'warn');
        }

        expect(lines, attribute).to.have.length(1);
        expect(lines[0]).to.contain('user:u-42').and.to.contain(attribute).and.to.not.contain(id);
      }
    });

    /** The storage key of a session id, as the issuer derives it, saved with undecodable Data. */
    async function undecodable(store: DynamoDbSessionProvider, raw: string): Promise<string> {
      const key = createHash('sha256').update(raw).digest('hex');
      await store.save(session({ SessionId: key, Subject: user('u-42') }));
      // The Map reviver's TypeError quotes this whole value.
      item(key).Data = { S: `{"dataType":"Map","value":["${STORED_DATA}"]}` };
      return key;
    }

    const STORED_DATA = 'refresh-token-kept-in-the-stored-data';
    const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'security', 'success'] as const;

    async function warnings<T>(run: () => Promise<T>): Promise<[T, string[]]> {
      const log = DI.resolve(Log, ['dynamo-session-store']);
      const calls: unknown[][] = [];
      for (const level of LEVELS) {
        log[level] = (...args: unknown[]) => {
          calls.push(args);
        };
      }
      try {
        return [await run(), calls.map((args) => [...args.map(String), ...args.map((a) => inspect(a, { depth: null }))].join(' '))];
      } finally {
        for (const level of LEVELS) {
          Reflect.deleteProperty(log, level);
        }
      }
    }

    const runsOf = (secret: string) => Array.from({ length: secret.length - 7 }, (_, i) => secret.slice(i, i + 8));

    function expectNamesSubjectOnly(lines: string[], secrets: string[]) {
      expect(lines).to.have.length(1);
      expect([...secrets, STORED_DATA].flatMap(runsOf).filter((run) => lines[0].includes(run)), 'runs of the session id, its storage key or the stored Data').to.deep.equal([]);
      expect(lines[0]).to.contain('user:u-42').and.to.contain('Data');
    }

    it('restore of an item whose Data does not decode answers null and logs the subject and Data, never the session id or its storage key', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();
      const raw = 'raw-session-id-of-the-cookie-restore';
      const key = await undecodable(store, raw);

      const [restored, lines] = await warnings(() => store.restore(key));
      expect(restored).to.equal(null);
      expectNamesSubjectOnly(lines, [raw, key]);

      item(key).Subject = { N: '0' };
      const [unowned, none] = await warnings(() => store.restore(key));
      expect(unowned, 'an unreadable Subject reads as absent').to.equal(null);
      expect(none, 'and is not logged, as everywhere in this store').to.deep.equal([]);
    });

    it('a listing reads an item whose Data does not decode with an empty Data and logs the subject and Data, never the session id or its storage key', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();
      const raw = 'raw-session-id-of-the-cookie-listing';
      const key = await undecodable(store, raw);

      const [listed, lines] = await warnings(() => store.listBySubject(user('u-42')));
      expect(ids(listed)).to.deep.equal([key]);
      expect(listed[0].Data.size).to.equal(0);
      expectNamesSubjectOnly(lines, [raw, key]);
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

    it('touch writes the renewed Expiration as epoch seconds, the TTL attribute', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();

      await store.save(session({ SessionId: 't-ttl', Expiration: DateTime.now().plus({ seconds: 30 }) }));
      const view = (await store.restore('t-ttl'))!;
      expect(await store.touch(view)).to.be.true;

      expect(item('t-ttl').Expiration).to.deep.equal({ N: `${view.Expiration!.toMillis() / 1000}` });
      expect(Number(item('t-ttl').Expiration.N)).to.be.greaterThan(DateTime.now().plus({ minutes: 59 }).toSeconds());
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
      item('t-lapsed').Expiration = { N: `${Math.floor(DateTime.now().minus({ seconds: 2 }).toSeconds())}` };

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

    it('an item whose Data does not decode keeps the owner its own attributes give', async () => {
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

  });
});
