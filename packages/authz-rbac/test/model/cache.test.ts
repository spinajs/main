import { GLOBAL } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, ResourceRef } from '@spinajs/authz';
import { ManualClock, fakeEvaluationContext } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { AssignmentCache, AssignmentStore, isLive, subjectKey } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const SECOND = 1000;
const TTL = 60 * SECOND;
const alice: AssignmentSubject = { type: 'user', id: 'alice' };
const bob: AssignmentSubject = { type: 'user', id: 'bob' };
const carol: AssignmentSubject = { type: 'user', id: 'carol' };
const members: AssignmentSubject = { set: { role: 'org.member', scope: { type: 'org', id: 'o1' } } };

const row = (id: string, subject: AssignmentSubject, role = 'viewer', extra: Partial<Assignment> = {}): Assignment => ({ id, subject, role, scope: GLOBAL as ResourceRef, source: 'test', ...extra });

type Rows = readonly Assignment[];

interface Call {
  readonly keys: readonly string[];
  readonly at: Date;
  resolve(): void;
  reject(e: Error): void;
}

/** Answers from `rows`; with `manual` each call waits until the test settles it. */
class ScriptedStore extends AssignmentStore {
  readonly name = 'scripted';
  readonly calls: Call[] = [];
  manual = false;
  extra: Assignment[] = [];

  constructor(public rows: Assignment[] = []) {
    super();
  }

  forSubjects(subjects: readonly AssignmentSubject[], at: Date): Promise<Rows> {
    const keys = subjects.map(subjectKey);
    // Read when the call settles, so a test can change the rows while a load is in flight.
    const answer = () => [...this.rows.filter((a) => keys.includes(subjectKey(a.subject)) && isLive(a, at)), ...this.extra];
    return new Promise<Rows>((resolve, reject) => {
      const call: Call = { keys, at, resolve: () => resolve(answer()), reject };
      this.calls.push(call);
      if (!this.manual) call.resolve();
    });
  }

  async holders(): Promise<readonly AssignmentSubject[]> {
    return [];
  }

  async byId(): Promise<Assignment | null> {
    return null;
  }
}

const isThenable = (v: unknown): boolean => typeof (v as { then?: unknown } | null)?.then === 'function';

const ids = (rows: Rows) => rows.map((a) => a.id);

/** A fresh request context: nothing in ctx.cache, so only the cross-request cache can answer. */
const request = (now: Date = NOW) => fakeEvaluationContext({ now });

/** The rows when `read` answers without IO; fails the test otherwise. */
const now = (v: Rows | Promise<Rows>): Rows => {
  expect(isThenable(v), 'read answered with a promise').to.equal(false);
  return v as Rows;
};

const setup = (rows: Assignment[] = [], opts: { ttlMs?: number; maxEntries?: number } = {}) => {
  const store = new ScriptedStore(rows);
  const clock = new ManualClock(NOW);
  const cache = new AssignmentCache(store, { ttlMs: opts.ttlMs ?? TTL, maxEntries: opts.maxEntries ?? 100, clock, model: 'rbac' });
  return { store, clock, cache };
};

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('authz-rbac model: AssignmentCache', () => {
  it('loads the missing subjects in one store read, then answers from memory without IO', async () => {
    const { store, cache } = setup([row('a1', alice), row('b1', bob), row('c1', carol)]);
    const first = cache.read([alice, bob], request());
    expect(isThenable(first)).to.equal(true);
    expect(ids(await first)).to.deep.equal(['a1', 'b1']);
    expect(store.calls.map((c) => c.keys)).to.deep.equal([['user:alice', 'user:bob']]);
    expect(ids(now(cache.read([alice, bob], request())))).to.deep.equal(['a1', 'b1']);
    expect(ids(now(cache.read([bob], request())))).to.deep.equal(['b1']);
    expect(store.calls).to.have.length(1);
  });

  it('caches per subject: a request for alice and carol reads only carol', async () => {
    const { store, cache } = setup([row('a1', alice), row('c1', carol)]);
    await cache.read([alice], request());
    expect(ids(await cache.read([carol, alice], request()))).to.deep.equal(['c1', 'a1']);
    expect(store.calls.map((c) => c.keys)).to.deep.equal([['user:alice'], ['user:carol']]);
  });

  it('passes ctx.now to the store and caches an empty answer as a real one', async () => {
    const { store, cache } = setup();
    expect(await cache.read([bob], request())).to.deep.equal([]);
    expect(store.calls[0].at.getTime()).to.equal(NOW.getTime());
    expect(now(cache.read([bob], request()))).to.deep.equal([]);
  });

  it('hands out deep-frozen copies of the rows and leaves the store objects alone', async () => {
    const stored = row('a1', members, 'viewer', { tags: ['inspect'], scope: { type: 'org', id: 'o1' }, expiresAt: new Date(NOW.getTime() + SECOND) });
    const { cache } = setup([stored]);
    const [cached] = await cache.read([members], request());
    expect(cached).to.deep.equal(stored);
    expect(cached).to.not.equal(stored);
    for (const part of [cached, cached.subject, (cached.subject as { set: object }).set, (cached.subject as { set: { scope: object } }).set.scope, cached.scope, cached.tags]) expect(Object.isFrozen(part)).to.equal(true);
    expect(cached.expiresAt).to.be.instanceOf(Date);
    expect(cached.expiresAt, "the store's Date is not shared").to.not.equal(stored.expiresAt);
    expect(cached.expiresAt?.getTime()).to.equal(stored.expiresAt?.getTime());
    expect(() => (cached.tags as string[]).push('code')).to.throw(TypeError);
    expect(Object.isFrozen(stored) || Object.isFrozen(stored.tags)).to.equal(false);
  });

  it('a Date from another realm stays a Date in the copy', async () => {
    const { runInNewContext } = await import('node:vm');
    const foreign = runInNewContext(`new Date(${NOW.getTime() + SECOND})`) as Date;
    const { cache } = setup([row('a1', alice, 'viewer', { expiresAt: foreign })]);
    const [cached] = await cache.read([alice], request());
    expect(cached.expiresAt).to.be.instanceOf(Date);
    expect(Date.prototype.getTime.call(cached.expiresAt)).to.equal(NOW.getTime() + SECOND);
  });

  it('drops the rows of subjects it did not ask for', async () => {
    const { store, cache } = setup([row('a1', alice)]);
    store.extra = [row('x1', bob, 'admin')];
    expect(ids(await cache.read([alice], request()))).to.deep.equal(['a1']);
    store.extra = [];
    const forBob = cache.read([bob], request());
    expect(isThenable(forBob)).to.equal(true);
    expect(await forBob).to.deep.equal([]);
  });

  it('expires an entry after the TTL on its own clock, counted from the start of the load', async () => {
    const { store, clock, cache } = setup([row('a1', alice)]);
    await cache.read([alice], request());
    clock.advance(TTL - 1);
    now(cache.read([alice], request()));
    clock.advance(1);
    const again = cache.read([alice], request());
    expect(isThenable(again)).to.equal(true);
    await again;
    expect(store.calls).to.have.length(2);
  });

  it('drops an entry when the clock has gone back past its load, so the TTL still bounds it', async () => {
    const { store, clock, cache } = setup([row('a1', alice)]);
    await cache.read([alice], request());
    clock.advance(-1);
    const again = cache.read([alice], request());
    expect(isThenable(again)).to.equal(true);
    await again;
    expect(store.calls).to.have.length(2);
  });

  it('does not serve an entry to a request whose now lies before the load (an assignment it filtered may be live then)', async () => {
    const later = new Date(NOW.getTime() + 10 * SECOND);
    const { store, cache } = setup([row('a1', alice, 'viewer', { expiresAt: new Date(NOW.getTime() + 5 * SECOND) })]);
    expect(ids(await cache.read([alice], request(later)))).to.deep.equal([]);
    expect(ids(await cache.read([alice], request(NOW)))).to.deep.equal(['a1']);
    expect(store.calls).to.have.length(2);
    // An entry loaded at NOW serves any later request; the model re-checks expiry against ctx.now.
    expect(ids(now(cache.read([alice], request(later))))).to.deep.equal(['a1']);
  });

  it('a TTL of 0 keeps nothing across requests', async () => {
    const { store, cache } = setup([row('a1', alice)], { ttlMs: 0 });
    await cache.read([alice], request());
    expect(isThenable(cache.read([alice], request()))).to.equal(true);
    await settle();
    expect(store.calls).to.have.length(2);
  });

  it('holds at most maxEntries subjects and drops the least recently used first', async () => {
    const { store, cache } = setup([row('a1', alice), row('b1', bob), row('c1', carol)], { maxEntries: 2 });
    await cache.read([alice], request());
    await cache.read([bob], request());
    now(cache.read([alice], request()));
    await cache.read([carol], request());
    now(cache.read([alice], request()));
    now(cache.read([carol], request()));
    expect(isThenable(cache.read([bob], request()))).to.equal(true);
    await settle();
    expect(store.calls.map((c) => c.keys)).to.deep.equal([['user:alice'], ['user:bob'], ['user:carol'], ['user:bob']]);
  });

  describe('per request (ctx.cache)', () => {
    it('one context reads the store once, also while the load is in flight, and then answers without IO', async () => {
      const { store, cache } = setup([row('a1', alice)]);
      store.manual = true;
      const ctx = request();
      const p1 = cache.read([alice], ctx);
      const p2 = cache.read([alice], ctx);
      await settle();
      expect(store.calls).to.have.length(1);
      store.calls[0].resolve();
      expect(ids(await p1)).to.deep.equal(['a1']);
      expect(ids(await p2)).to.deep.equal(['a1']);
      expect(ids(now(cache.read([alice], ctx)))).to.deep.equal(['a1']);
    });

    it('a context that read its rows answers without IO after the cross-request entry expired', async () => {
      const { clock, cache } = setup([row('a1', alice)]);
      const ctx = request();
      await cache.read([alice], ctx);
      clock.advance(2 * TTL);
      expect(ids(now(cache.read([alice], ctx)))).to.deep.equal(['a1']);
      expect(isThenable(cache.read([alice], request()))).to.equal(true);
    });

    it('a context keys its rows on the subject list', async () => {
      const { store, cache } = setup([row('a1', alice), row('b1', bob)]);
      const ctx = request();
      await cache.read([alice], ctx);
      expect(ids(await cache.read([alice, bob], ctx))).to.deep.equal(['a1', 'b1']);
      expect(store.calls.map((c) => c.keys)).to.deep.equal([['user:alice'], ['user:bob']]);
    });
  });

  describe('invalidate', () => {
    const loaded = async (tags: unknown) => {
      const s = setup([row('a1', alice), row('b1', bob), row('m1', members)]);
      await s.cache.read([alice, bob, members], request());
      s.cache.invalidate(tags as readonly string[]);
      const cached = (who: AssignmentSubject) => !isThenable(s.cache.read([who], request()));
      return { ...s, alice: cached(alice), bob: cached(bob), members: cached(members) };
    };

    it('subject:<principalKey> drops that subject and every subject set, and keeps the other principals', async () => {
      expect(await loaded(['subject:user:alice'])).to.include({ alice: false, bob: true, members: false });
    });

    it('model:rbac drops everything; another model and policy or rule tags drop nothing', async () => {
      expect(await loaded(['model:rbac'])).to.include({ alice: false, bob: false, members: false });
      expect(await loaded(['model:abac', 'policy:p1', 'rule:r1'])).to.include({ alice: true, bob: true, members: true });
    });

    for (const tags of [['*'], ['scope:org:o1'], ['role:viewer'], ['link:l1'], ['ghost:x'], ['subject:user:bob', 'nonsense'], [42], 'subject:user:alice', null]) {
      it(`${JSON.stringify(tags)} drops everything (fail safe)`, async () => {
        expect(await loaded(tags)).to.include({ alice: false, bob: false, members: false });
      });
    }

    it('the next read after a subject tag sees the store change', async () => {
      const { store, cache } = setup([row('a1', alice)]);
      await cache.read([alice], request());
      store.rows.push(row('a2', alice, 'writer'));
      expect(ids(now(cache.read([alice], request())))).to.deep.equal(['a1']);
      cache.invalidate(['subject:user:alice']);
      expect(ids(await cache.read([alice], request()))).to.deep.equal(['a1', 'a2']);
    });

    it('a load in flight when an invalidate arrives answers its callers but does not fill the cache', async () => {
      const { store, cache } = setup([row('a1', alice)]);
      store.manual = true;
      const inFlight = cache.read([alice], request());
      await settle();
      cache.invalidate(['subject:user:alice']);
      store.calls[0].resolve();
      expect(ids(await inFlight)).to.deep.equal(['a1']);
      store.manual = false;
      expect(isThenable(cache.read([alice], request()))).to.equal(true);
      await settle();
      expect(store.calls).to.have.length(2);
    });

    it('a read after an invalidate does not join the load that was in flight before it', async () => {
      const { store, cache } = setup([row('a1', alice)]);
      store.manual = true;
      const stale = cache.read([alice], request());
      await settle();
      cache.invalidate(['subject:user:alice']);
      store.rows.push(row('a2', alice, 'writer'));
      const fresh = cache.read([alice], request());
      await settle();
      expect(store.calls).to.have.length(2);
      // The stale load answers last; the fresh one must still be what the cache keeps.
      store.calls[1].resolve();
      expect(ids(await fresh)).to.deep.equal(['a1', 'a2']);
      store.calls[0].resolve();
      await stale;
      expect(ids(now(cache.read([alice], request())))).to.deep.equal(['a1', 'a2']);
    });

    it('a context does not reuse rows it read before an invalidate', async () => {
      const { store, cache } = setup([row('a1', alice)]);
      const ctx = request();
      await cache.read([alice], ctx);
      store.rows.push(row('a2', alice, 'writer'));
      cache.invalidate(['subject:user:alice']);
      expect(ids(await cache.read([alice], ctx))).to.deep.equal(['a1', 'a2']);
    });

    it('an unrelated invalidate does not make a preloaded context lose its answer without IO', async () => {
      const { cache } = setup([row('a1', alice)]);
      const ctx = request();
      await cache.read([alice], ctx);
      cache.invalidate(['subject:user:bob']);
      expect(ids(now(cache.read([alice], ctx)))).to.deep.equal(['a1']);
    });
  });

  describe('failed loads', () => {
    it('a failed load rejects every caller that shares it and is not cached', async () => {
      const { store, cache } = setup([row('a1', alice)]);
      store.manual = true;
      const ctx = request();
      const p1 = cache.read([alice], ctx);
      const p2 = cache.read([alice], request());
      await settle();
      expect(store.calls).to.have.length(1);
      store.calls[0].reject(new Error('db down'));
      for (const p of [p1, p2]) {
        const err = await Promise.resolve(p).then(
          () => undefined,
          (e: Error) => e,
        );
        expect(err?.message).to.equal('db down');
      }
      store.manual = false;
      expect(ids(await cache.read([alice], ctx))).to.deep.equal(['a1']);
      expect(store.calls).to.have.length(2);
    });

    it('a store that throws synchronously rejects, and the next read tries again', async () => {
      const { store, cache } = setup([row('a1', alice)]);
      const real = store.forSubjects.bind(store);
      let fail = true;
      store.forSubjects = (s, at) => {
        if (fail) throw new Error('bad call');
        return real(s, at);
      };
      const err = await Promise.resolve(cache.read([alice], request())).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(err?.message).to.equal('bad call');
      fail = false;
      expect(ids(await cache.read([alice], request()))).to.deep.equal(['a1']);
    });

    it('a row whose subject cannot be read fails the load rather than vanishing', async () => {
      const { store, cache } = setup();
      store.extra = [{ ...row('x1', alice), subject: null as unknown as AssignmentSubject }];
      const err = await Promise.resolve(cache.read([alice], request())).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(err).to.be.instanceOf(Error);
      store.extra = [];
      expect(await cache.read([alice], request())).to.deep.equal([]);
    });
  });
});
