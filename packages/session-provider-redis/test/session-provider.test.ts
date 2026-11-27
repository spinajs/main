import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { UserSession as Session, encodeSessionData } from '@spinajs/authn-session';
import type { ISession } from '@spinajs/authn-session';
import { DateTime } from 'luxon';
import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log';
import { RedisSessionStore } from '../src/index.js';
import { runSessionProviderConformance, IConformanceExpiration, SessionProviderFactory } from '../../authn-session/test/conformance/session-provider-conformance.js';
import { bootStore, disposeStore, rawClient } from './support.js';

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

const stored = async (key: string) => JSON.parse((await rawClient().get(key))!);
const members = async (key: string) => (await rawClient().smembers(key)).sort();
const ids = (list: ISession[]) => list.map((s) => s.SessionId).sort();

/** Runs `between` once, after touch has read the row and before its compare-and-set reaches Redis. */
function raceTouch(store: RedisSessionStore, between: () => Promise<unknown>): () => number {
  const client = (store as unknown as { Client: { eval: (...args: unknown[]) => Promise<unknown> } }).Client;
  const original = client.eval.bind(client);
  let calls = 0;
  client.eval = async (...args: unknown[]) => {
    if (calls++ === 0) {
      await between();
    }
    return original(...args);
  };
  return () => calls;
}

describe('redis session provider', function () {
  this.timeout(15000);

  after(async () => {
    await disposeStore();
  });

  runSessionProviderConformance(conformanceFactory);

  describe('RedisSessionStore regressions', () => {
    it("deleteBySubject removes only the target subject's sessions across multiple subjects", async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();

      await store.save(session({ SessionId: 'r-u1-a', Subject: user('1') }));
      await store.save(session({ SessionId: 'r-u1-b', Subject: user('1') }));
      await store.save(session({ SessionId: 'r-u2', Subject: user('2') }));
      await store.save(session({ SessionId: 'r-u2-imp', Subject: user('2'), Impersonator: user('1') }));

      expect(await store.deleteBySubject(user('1'))).to.equal(2);

      expect(await store.restore('r-u1-a'), 'u1 session a gone').to.be.null;
      expect(await store.restore('r-u1-b'), 'u1 session b gone').to.be.null;
      expect(await store.restore('r-u2'), 'u2 session survives').to.not.be.null;
      expect(await store.restore('r-u2-imp'), 'the impersonation u1 started survives a plain delete').to.not.be.null;
    });

    it('listBySubject returns live sessions and prunes expired ids from the subject set', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();

      await store.save(session({ SessionId: 'r-live', Subject: user('9') }));
      await store.save(session({ SessionId: 'r-expired', Subject: user('9') }));

      // The physical key lingers with a past Expiration while its id stays in the subject set.
      const raw = await stored('session:r-expired');
      raw.Expiration = DateTime.now().minus({ minutes: 5 }).toISO();
      await rawClient().set('session:r-expired', JSON.stringify(raw));

      expect(ids(await store.listBySubject(user('9')))).to.deep.equal(['r-live']);
      expect(await members('session:subject:user:9')).to.deep.equal(['r-live']);
    });

    it('save persists an already-set Expiration verbatim', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();

      const fixed = DateTime.fromISO('2031-05-06T07:08:09.000Z');
      await store.save(session({ SessionId: 'r-verbatim', Subject: user('3'), Expiration: fixed }));
      const restored = await store.restore('r-verbatim');

      expect(restored).to.not.be.null;
      expect(restored!.Expiration!.toMillis()).to.equal(fixed.toMillis());
    });

    it('restore returns null for an expired session even if the mock kept the key', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();

      await store.save(session({ SessionId: 'r-ghost', Subject: user('4'), Expiration: DateTime.now().plus({ hours: 1 }) }));

      // Flip the stored Expiration to the past without a Redis TTL.
      const client = rawClient();
      const raw = await stored('session:r-ghost');
      raw.Expiration = DateTime.now().minus({ hours: 1 }).toISO();
      await client.set('session:r-ghost', JSON.stringify(raw));

      expect(await client.get('session:r-ghost'), 'mock still holds the key').to.not.be.null;
      expect(await store.restore('r-ghost'), 'expired session reads as absent').to.be.null;
    });

    it('an Expiration that is present but not an ISO instant counts as passed; only an absent one means never', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();
      const unreadable: [string, unknown][] = [
        ['empty text', ''],
        ['null', null],
        ['zero', 0],
        ['false', false],
        ['a number that reads as an ISO year', 2099],
        ['blank text', '   '],
        ['text that is no date', 'Invalid DateTime'],
        ['an object', {}],
      ];

      for (const [label, value] of [['absent', undefined], ...unreadable] as [string, unknown][]) {
        const id = `r-unreadable-${label.replace(/\W+/g, '-')}`;
        await store.save(session({ SessionId: id, Subject: user('u-42') }));
        const raw = await stored(`session:${id}`);
        raw.Expiration = value;
        await rawClient().set(`session:${id}`, JSON.stringify(raw));

        const restored = await store.restore(id);
        if (value === undefined) {
          expect(restored, label).to.not.be.null;
          expect(restored!.Expiration, label).to.equal(undefined);
        } else {
          expect(restored, label).to.equal(null);
          expect(await rawClient().exists(`session:${id}`), `${label}: deleted as an expired row is`).to.equal(0);
        }
      }

      const id = 'r-unreadable-listed';
      await store.save(session({ SessionId: id, Subject: user('u-42') }));
      const raw = await stored(`session:${id}`);
      raw.Expiration = '';
      await rawClient().set(`session:${id}`, JSON.stringify(raw));
      expect(ids(await store.listBySubject(user('u-42')))).to.deep.equal(['r-unreadable-absent']);
    });

    it('an unreadable Expiration is logged once, naming the subject and never the session id', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();
      const id = 'r-warn-bearer-key';
      await store.save(session({ SessionId: id, Subject: user('u-42') }));
      const raw = await stored(`session:${id}`);
      raw.Expiration = '';
      await rawClient().set(`session:${id}`, JSON.stringify(raw));

      const log = DI.resolve(Log, ['redis-session-store']);
      const original = log.warn;
      const lines: string[] = [];
      log.warn = (first: unknown) => {
        lines.push(String(first));
      };
      try {
        expect(await store.restore(id)).to.equal(null);
        expect(await store.restore(id)).to.equal(null);
      } finally {
        log.warn = original;
      }

      expect(lines).to.have.length(1);
      expect(lines[0]).to.contain('user:u-42');
      expect(lines[0]).to.not.contain(id);
    });

    it('an unreadable Creation never turns a capped session into one that never expires', async () => {
      const store = await makeProvider({ service: 'SlidingCappedExpiration', ttl: 60, maxLifetime: 600 });
      await store.truncate();
      for (const [label, value] of [['empty text', ''], ['absent', undefined], ['zero', 0], ['no date', 'x']] as [string, unknown][]) {
        const id = `r-creation-${label.replace(/\W+/g, '-')}`;
        await store.save(session({ SessionId: id, Subject: user('u-42') }));
        const raw = await stored(`session:${id}`);
        raw.Creation = value;
        await rawClient().set(`session:${id}`, JSON.stringify(raw));

        const restored = await store.restore(id);
        expect(restored, label).to.not.be.null;
        await store.touch(restored!);
        expect(await store.restore(id), `${label}: renewed past its cap`).to.equal(null);
      }
    });

    /** An impersonated session from IdP session ek-1, with one stored field rewritten (undefined drops it). */
    async function savedWith(store: RedisSessionStore, id: string, field: string, value: unknown) {
      await store.save(session({ SessionId: id, Subject: user('u-42'), Impersonator: user('admin'), ExternalKey: 'ek-1' }));
      const raw = await stored(`session:${id}`);
      raw[field] = value;
      await rawClient().set(`session:${id}`, JSON.stringify(raw));
    }

    const REVOCATIONS: [field: string, readable: unknown, revoke: (store: RedisSessionStore) => Promise<number>, unreadable: [string, unknown][]][] = [
      [
        'Impersonator',
        'user:admin',
        (store) => store.deleteBySubject(user('admin'), { includeImpersonations: true }),
        [['empty text', ''], ['zero', 0], ['false', false], ['null', null], ['an object', {}], ['an array', []], ['a number', 42], ['text without a type', 'admin'], ['an empty type', ':admin'], ['an empty id', 'user:']],
      ],
      ['ExternalKey', 'ek-1', (store) => store.deleteByExternalKey('ek-1'), [['zero', 0], ['false', false], ['null', null], ['an object', {}], ['an array', []], ['a number', 42]]],
    ];

    for (const [field, readable, revoke, unreadable] of REVOCATIONS) {
      it(`a present but unreadable ${field} ends the session, so the revocation that looks for it cannot leave it live`, async () => {
        const store = await makeProvider(SLIDING);
        await store.truncate();

        for (const [label, value] of [['readable', readable], ['absent', undefined], ...unreadable] as [string, unknown][]) {
          const id = `r-${field}-${label.replace(/\W+/g, '-')}`;
          await savedWith(store, id, field, value);

          expect(await revoke(store), `${label}: revoked and counted`).to.equal(value === readable ? 1 : 0);
          const restored = await store.restore(id);
          if (value === undefined) {
            expect(restored, `${label}: untouched by the revocation`).to.not.be.null;
          } else {
            expect(restored, label).to.equal(null);
            expect(await rawClient().exists(`session:${id}`), `${label}: deleted`).to.equal(0);
          }

          const listed = `${id}-listed`;
          await savedWith(store, listed, field, value);
          expect(ids(await store.listBySubject(user('u-42'))).includes(listed), `${label}: listed`).to.equal(value === readable || value === undefined);
          await store.delete(listed);
        }
      });
    }

    it('an unreadable Impersonator or ExternalKey is logged once, naming the subject and the field and never the session id', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();
      const log = DI.resolve(Log, ['redis-session-store']);
      const original = log.warn;

      for (const field of ['Impersonator', 'ExternalKey']) {
        const id = `r-warn-${field}-bearer-key`;
        await savedWith(store, id, field, 0);
        const lines: string[] = [];
        log.warn = (first: unknown) => {
          lines.push(String(first));
        };
        try {
          expect(await store.restore(id)).to.equal(null);
          expect(await store.restore(id)).to.equal(null);
        } finally {
          log.warn = original;
        }

        expect(lines, field).to.have.length(1);
        expect(lines[0]).to.contain('user:u-42').and.to.contain(field).and.to.not.contain(id);
      }
    });
  });

  describe('3.0 key layout', () => {
    it('SR-06 save stores Subject, Impersonator and State in the value and indexes the subject and impersonator sets', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();

      await store.save(session({ SessionId: 'k-imp', Subject: user('victim'), Impersonator: user('admin') }));

      const raw = await stored('session:k-imp');
      expect(raw.Subject).to.equal('user:victim');
      expect(raw.Impersonator).to.equal('user:admin');
      expect(raw.State).to.equal('active');
      expect(await members('session:subject:user:victim')).to.deep.equal(['k-imp']);
      expect(await members('session:impersonator:user:admin')).to.deep.equal(['k-imp']);
      expect(await rawClient().pttl('session:k-imp'), 'the key expires with the session').to.be.greaterThan(0);
    });

    it('set keys escape the principal type like principalKey', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();

      const odd = { type: 'a:b%', id: 'x:y' };
      await store.save(session({ SessionId: 'k-odd', Subject: odd }));

      expect(await members('session:subject:a%3Ab%25:x:y')).to.deep.equal(['k-odd']);
      expect({ ...(await store.restore('k-odd'))!.Subject }).to.deep.equal(odd);
      expect(ids(await store.listBySubject(odd))).to.deep.equal(['k-odd']);
    });

    it('save moves the id to the new sets when a row changes Subject or Impersonator', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();

      await store.save(session({ SessionId: 'k-move', Subject: user('a'), Impersonator: user('admin') }));
      await store.save(session({ SessionId: 'k-move', Subject: user('b') }));

      expect(await members('session:subject:user:a')).to.deep.equal([]);
      expect(await members('session:impersonator:user:admin')).to.deep.equal([]);
      expect(await members('session:subject:user:b')).to.deep.equal(['k-move']);
      expect(await store.deleteBySubject(user('admin'), { includeImpersonations: true })).to.equal(0);
      expect(await store.restore('k-move')).to.not.be.null;
    });

    it('delete removes the key and its set memberships', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();

      await store.save(session({ SessionId: 'k-del', Subject: user('victim'), Impersonator: user('admin') }));
      await store.delete('k-del');

      expect(await rawClient().exists('session:k-del')).to.equal(0);
      expect(await members('session:subject:user:victim')).to.deep.equal([]);
      expect(await members('session:impersonator:user:admin')).to.deep.equal([]);
    });

    it('SR-session revocation: deleteBySubject also ends a row saved for the subject while it runs (rotation racing a ban)', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();
      await store.save(session({ SessionId: 'k-old', Subject: user('banned') }));

      const client = (store as unknown as { Client: { smembers: (key: string) => Promise<string[]> } }).Client;
      const original = client.smembers.bind(client);
      let calls = 0;
      client.smembers = async (key: string) => {
        const result = await original(key);
        if (calls++ === 0) {
          const raw = await stored('session:k-old');
          await rawClient().set('session:k-rotated', JSON.stringify(raw));
          await rawClient().sadd('session:subject:user:banned', 'k-rotated');
        }
        return result;
      };

      expect(await store.deleteBySubject(user('banned'))).to.equal(2);
      expect(await rawClient().exists('session:k-rotated')).to.equal(0);
    });

    it('a stale set member pointing at another subject is neither listed nor deleted, and is pruned', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();

      await store.save(session({ SessionId: 'k-other', Subject: user('other') }));
      await rawClient().sadd('session:subject:user:me', 'k-other', 'k-gone');

      expect(await store.listBySubject(user('me'))).to.deep.equal([]);
      expect(await store.deleteBySubject(user('me'))).to.equal(0);
      expect(await store.restore('k-other')).to.not.be.null;
      expect(await members('session:subject:user:me')).to.deep.equal([]);
    });

    it('honours the connection keyPrefix in every command and in the sets', async () => {
      const store = await bootStore({ expiration: SLIDING, redis: { keyPrefix: 'app:' } });
      await store.truncate();
      const client = rawClient();
      await client.set('session:foreign', 'not ours');

      await store.save(session({ SessionId: 'k-pre', Subject: user('p'), Impersonator: user('admin'), Expiration: DateTime.now().plus({ seconds: 30 }) }));
      expect(await client.exists('app:session:k-pre')).to.equal(1);
      expect(await members('app:session:subject:user:p')).to.deep.equal(['k-pre']);

      const restored = (await store.restore('k-pre'))!;
      expect(await store.touch(restored)).to.be.true;
      expect(ids(await store.listBySubject(user('admin'), { includeImpersonations: true }))).to.deep.equal(['k-pre']);

      await store.save(session({ SessionId: 'k-pre-b', Subject: user('p') }));
      expect(await store.deleteBySubject(user('p'))).to.equal(2);

      await store.save(session({ SessionId: 'k-pre-2', Subject: user('p') }));
      await store.truncate();
      expect(await client.exists('app:session:k-pre-2')).to.equal(0);
      expect(await client.get('session:foreign'), 'truncate stays inside the prefix').to.equal('not ours');
      await client.del('session:foreign');
    });
  });

  describe('touch (update-only compare-and-set)', () => {
    it('SR-07 touch with an active view never extends a row stored as pending', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();

      const fixed = DateTime.now().plus({ minutes: 5 });
      await store.save(session({ SessionId: 't-pending', State: 'pending', Expiration: fixed }));

      const forged = session({ SessionId: 't-pending', State: 'active', Expiration: fixed });
      forged.Data.set('authn:facts', 'forged');
      expect(await store.touch(forged)).to.be.false;

      const after = (await store.restore('t-pending'))!;
      expect(after.State).to.equal('pending');
      expect(after.Expiration!.toMillis()).to.equal(fixed.toMillis());
      expect(after.Data.has('authn:facts'), 'nothing of the forged view is written').to.be.false;
    });

    it('touch renews the Redis TTL with the Expiration', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();

      await store.save(session({ SessionId: 't-ttl', Expiration: DateTime.now().plus({ seconds: 30 }) }));
      expect(await store.touch((await store.restore('t-ttl'))!)).to.be.true;

      expect(await rawClient().pttl('session:t-ttl')).to.be.greaterThan(59 * 60 * 1000);
    });

    it('SR-session idle timeout: touch never extends a row whose Expiration passed while Redis still holds the key', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();

      await store.save(session({ SessionId: 't-lapsed', Expiration: DateTime.now().plus({ hours: 1 }) }));
      const restored = (await store.restore('t-lapsed'))!;
      const raw = await stored('session:t-lapsed');
      raw.Expiration = DateTime.now().minus({ seconds: 1 }).toISO();
      await rawClient().set('session:t-lapsed', JSON.stringify(raw));

      expect(await store.touch(restored)).to.be.false;
      expect(await store.restore('t-lapsed')).to.be.null;
    });

    it('SR-session revocation: touch never re-creates a row deleted between its read and its write', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();

      await store.save(session({ SessionId: 't-race-del', Expiration: DateTime.now().plus({ seconds: 30 }) }));
      const restored = (await store.restore('t-race-del'))!;
      raceTouch(store, () => rawClient().del('session:t-race-del'));

      expect(await store.touch(restored)).to.be.false;
      expect(await rawClient().exists('session:t-race-del'), 'a logout between read and write stays in force').to.equal(0);
    });

    it('SR-07 touch never extends a row that turned pending between its read and its write', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();

      const fixed = DateTime.now().plus({ seconds: 30 });
      await store.save(session({ SessionId: 't-race-state', Expiration: fixed }));
      const restored = (await store.restore('t-race-state'))!;
      raceTouch(store, async () => {
        const raw = await stored('session:t-race-state');
        raw.State = 'pending';
        await rawClient().set('session:t-race-state', JSON.stringify(raw));
      });

      expect(await store.touch(restored)).to.be.false;
      expect((await store.restore('t-race-state'))!.Expiration!.toMillis()).to.equal(fixed.toMillis());
    });

    it('touch retries over a concurrent write of the same row and lands its own Data', async () => {
      const store = await makeProvider(ABSOLUTE);
      await store.truncate();

      await store.save(session({ SessionId: 't-race-data' }));
      const restored = (await store.restore('t-race-data'))!;
      restored.Data.set('ActiveRole', 'editor');
      const calls = raceTouch(store, async () => {
        const raw = await stored('session:t-race-data');
        raw.Data = encodeSessionData(new Map<string, unknown>([['Ip', '203.0.113.9']]));
        await rawClient().set('session:t-race-data', JSON.stringify(raw));
      });

      expect(await store.touch(restored)).to.be.false;
      expect(calls(), 'the first compare-and-set lost and was retried').to.equal(2);
      expect((await store.restore('t-race-data'))!.Data.get('ActiveRole')).to.equal('editor');
    });
  });

  describe('undecodable rows', () => {
    it('a row whose Data does not decode keeps the owner its own fields give', async () => {
      const store = await makeProvider(SLIDING);
      await store.truncate();
      await store.save(session({ SessionId: 'bad-data', Subject: user('u-bad') }));
      const raw = await stored('session:bad-data');
      raw.Data = '{not json';
      await rawClient().set('session:bad-data', JSON.stringify(raw));

      const listed = await store.listBySubject(user('u-bad'));
      expect(ids(listed)).to.deep.equal(['bad-data']);
      expect(listed[0].Data.size).to.equal(0);
      expect(await store.deleteBySubject(user('u-bad'))).to.equal(1);
    });
  });
});
