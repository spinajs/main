import { GLOBAL } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import type { Assignment, AssignmentSubject } from '../../src/contracts.js';
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
  resolve(answer?: Assignment[]): void;
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
    // Read when the call settles, so a test can change the rows while a load is in flight; `resolve(rows)` answers with a snapshot instead.
    const answer = () => [...this.rows.filter((a) => keys.includes(subjectKey(a.subject)) && isLive(a, at)), ...this.extra];
    return new Promise<Rows>((resolve, reject) => {
      const call: Call = { keys, at, resolve: (snapshot) => resolve(snapshot ?? answer()), reject };
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

/** A ScriptedStore that tells the cache whether its reads run inside a transaction. */
class AnsweringStore extends ScriptedStore {
  inside = false;

  inTransaction(): boolean {
    return this.inside;
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

const setup = (rows: Assignment[] = [], opts: { ttlMs?: number; maxEntries?: number } = {}) => setupWith(new ScriptedStore(rows), opts);

const setupWith = <S extends ScriptedStore>(store: S, opts: { ttlMs?: number; maxEntries?: number } = {}) => {
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
    it('a read that overlaps a load still in flight loads for itself; once one settled the context answers without IO', async () => {
      const { store, cache } = setup([row('a1', alice)]);
      store.manual = true;
      const ctx = request();
      const p1 = cache.read([alice], ctx);
      const p2 = cache.read([alice], ctx);
      const p3 = cache.read([alice], request());
      await settle();
      expect(store.calls).to.have.length(3);
      for (const call of store.calls) call.resolve();
      for (const p of [p1, p2, p3]) expect(ids(await p)).to.deep.equal(['a1']);
      expect(ids(now(cache.read([alice], ctx)))).to.deep.equal(['a1']);
      expect(ids(now(cache.read([alice], request())))).to.deep.equal(['a1']);
      expect(store.calls).to.have.length(3);
    });

    it('a context does not keep the rows of a load that was in flight when an invalidate arrived', async () => {
      const { store, cache } = setup([row('a1', alice)]);
      store.manual = true;
      const ctx = request();
      const stale = cache.read([alice], ctx);
      await settle();
      cache.invalidate(['subject:user:alice']);
      store.calls[0].resolve([]);
      expect(await stale).to.deep.equal([]);
      store.manual = false;
      const again = cache.read([alice], ctx);
      expect(isThenable(again)).to.equal(true);
      expect(ids(await again)).to.deep.equal(['a1']);
    });

    it('an older read of a context never replaces the rows of a newer one', async () => {
      const { store, cache } = setup([row('a1', alice)]);
      store.manual = true;
      const ctx = request();
      const older = cache.read([alice], ctx);
      const fresher = cache.read([alice], ctx, { fresh: true });
      await settle();
      store.calls[1].resolve([row('a2', alice)]);
      expect(ids(await fresher)).to.deep.equal(['a2']);
      store.calls[0].resolve([row('a1', alice)]);
      await older;
      expect(ids(now(cache.read([alice], ctx)))).to.deep.equal(['a2']);
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
    it('a failed load rejects its own caller only and is not cached; the next read goes to the store', async () => {
      const { store, cache } = setup([row('a1', alice)]);
      store.manual = true;
      const ctx = request();
      const p1 = cache.read([alice], ctx);
      const p2 = cache.read([alice], ctx);
      await settle();
      expect(store.calls).to.have.length(2);
      store.calls[0].reject(new Error('db down'));
      const err = await Promise.resolve(p1).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(err?.message).to.equal('db down');
      store.calls[1].reject(new Error('db down'));
      await Promise.resolve(p2).catch(() => undefined);
      store.manual = false;
      expect(ids(await cache.read([alice], ctx))).to.deep.equal(['a1']);
      expect(store.calls).to.have.length(3);
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

  describe('sharing a load by the answer of inTransaction()', () => {
    const CONCURRENT = 10;

    /** Starts `CONCURRENT` reads of alice, each in a request of its own, and answers them once all reached the cache; returns the store reads they made. */
    const concurrentReads = async (store: ScriptedStore, cache: AssignmentCache): Promise<number> => {
      const before = store.calls.length;
      store.manual = true;
      const reads = Array.from({ length: CONCURRENT }, () => cache.read([alice], request()));
      await settle();
      const made = store.calls.length - before;
      store.manual = false;
      for (const call of store.calls.slice(before)) call.resolve();
      for (const rows of await Promise.all(reads)) expect(ids(rows)).to.deep.equal(['a1']);
      return made;
    };

    it('outside a transaction, concurrent first reads of a subject share one store read, cold and at TTL expiry', async () => {
      const { store, clock, cache } = setupWith(new AnsweringStore([row('a1', alice)]));
      const cold = await concurrentReads(store, cache);
      const warm = await concurrentReads(store, cache);
      clock.advance(TTL);
      const expired = await concurrentReads(store, cache);
      expect({ cold, warm, expired }).to.deep.equal({ cold: 1, warm: 0, expired: 1 });
    });

    it('inside a transaction, each read loads for itself and keeps nothing across requests', async () => {
      const { store, cache } = setupWith(new AnsweringStore([row('a1', alice)]));
      store.inside = true;
      const inside = await concurrentReads(store, cache);
      store.inside = false;
      const after = await concurrentReads(store, cache);
      expect({ inside, after }).to.deep.equal({ inside: CONCURRENT, after: 1 });
    });

    it('a reader inside a transaction does not join a load started outside, and a reader outside does not join a load started inside', async () => {
      const { store, cache } = setupWith(new AnsweringStore([row('a1', alice)]));
      store.manual = true;
      const outside = cache.read([alice], request());
      store.inside = true;
      const inside = cache.read([alice], request());
      store.inside = false;
      const outsideAfterInside = cache.read([alice], request());
      await settle();
      expect(store.calls).to.have.length(2);
      store.inside = true;
      const insideFirst = cache.read([bob], request());
      store.inside = false;
      const outsideJoiner = cache.read([bob], request());
      await settle();
      expect(store.calls.map((c) => c.keys)).to.deep.equal([['user:alice'], ['user:alice'], ['user:bob'], ['user:bob']]);
      for (const call of store.calls) call.resolve();
      for (const p of [outside, inside, outsideAfterInside]) expect(ids(await p)).to.deep.equal(['a1']);
      for (const p of [insideFirst, outsideJoiner]) expect(await p).to.deep.equal([]);
    });

    it('a load started before an invalidate is not joined by a read after it, and is not kept', async () => {
      const { store, cache } = setupWith(new AnsweringStore([row('a1', alice)]));
      store.manual = true;
      const stale = cache.read([alice], request());
      await settle();
      cache.invalidate(['subject:user:alice']);
      store.rows.push(row('a2', alice, 'writer'));
      const fresh = cache.read([alice], request());
      await settle();
      expect(store.calls).to.have.length(2);
      store.calls[0].resolve([row('a1', alice)]);
      expect(ids(await stale)).to.deep.equal(['a1']);
      const joiner = cache.read([alice], request());
      await settle();
      expect(store.calls, 'a read after the stale load settled joins the fresh one').to.have.length(2);
      store.calls[1].resolve();
      for (const p of [fresh, joiner]) expect(ids(await p)).to.deep.equal(['a1', 'a2']);
      expect(ids(now(cache.read([alice], request())))).to.deep.equal(['a1', 'a2']);
    });

    it('a reader whose now lies before a running load does not join it; a later one does', async () => {
      const later = new Date(NOW.getTime() + 10 * SECOND);
      const { store, cache } = setupWith(new AnsweringStore([row('a1', alice)]));
      store.manual = true;
      const first = cache.read([alice], request(later));
      const earlier = cache.read([alice], request(NOW));
      const laterStill = cache.read([alice], request(new Date(later.getTime() + SECOND)));
      await settle();
      expect(store.calls.map((c) => c.at.getTime())).to.deep.equal([later.getTime(), NOW.getTime()]);
      for (const call of store.calls) call.resolve();
      for (const p of [first, earlier, laterStill]) expect(ids(await p)).to.deep.equal(['a1']);
    });

    it('a failed shared load rejects the readers that joined it, keeps nothing, and the next read goes to the store', async () => {
      const { store, cache } = setupWith(new AnsweringStore([row('a1', alice)]));
      store.manual = true;
      const reads = [cache.read([alice], request()), cache.read([alice], request())];
      await settle();
      expect(store.calls).to.have.length(1);
      store.calls[0].reject(new Error('db down'));
      for (const p of reads) {
        const err = await Promise.resolve(p).then(
          () => undefined,
          (e: Error) => e,
        );
        expect(err?.message).to.equal('db down');
      }
      store.manual = false;
      expect(ids(await cache.read([alice], request()))).to.deep.equal(['a1']);
      expect(store.calls).to.have.length(2);
    });

    it('a store whose inTransaction() throws rejects the read', async () => {
      const store = new AnsweringStore([row('a1', alice)]);
      store.inTransaction = () => {
        throw new Error('no connection');
      };
      const { cache } = setupWith(store);
      const err = await Promise.resolve(cache.read([alice], request())).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(err?.message).to.equal('no connection');
      expect(store.calls).to.have.length(0);
    });

    it('a store without inTransaction() shares no load and keeps its rows across requests as before (store reads per phase)', async () => {
      const { store, clock, cache } = setup([row('a1', alice)]);
      const cold = await concurrentReads(store, cache);
      const warm = await concurrentReads(store, cache);
      clock.advance(TTL);
      const expired = await concurrentReads(store, cache);
      expect({ cold, warm, expired }).to.deep.equal({ cold: CONCURRENT, warm: 0, expired: CONCURRENT });
    });
  });

  it('a fresh read goes to the store past the request memo and the entries, and refreshes both', async () => {
    const { store, cache } = setup([row('a1', alice)]);
    const ctx = request();
    await cache.read([alice], ctx);
    store.rows = [row('a2', alice)];
    expect(ids(now(cache.read([alice], ctx)))).to.deep.equal(['a1']);
    expect(ids(await cache.read([alice], ctx, { fresh: true }))).to.deep.equal(['a2']);
    expect(store.calls).to.have.length(2);
    expect(ids(now(cache.read([alice], ctx)))).to.deep.equal(['a2']);
    expect(ids(now(cache.read([alice], request())))).to.deep.equal(['a2']);
  });

  it('a slower load that started before a fresh one never overwrites its rows', async () => {
    const { store, cache } = setup([row('a1', alice)]);
    store.manual = true;
    const older = cache.read([alice], request());
    store.rows = [row('a2', alice)];
    const fresher = cache.read([alice], request(), { fresh: true });
    await settle();
    expect(store.calls).to.have.length(2);
    store.calls[1].resolve();
    expect(ids(await fresher)).to.deep.equal(['a2']);
    store.calls[0].resolve([row('a1', alice)]); // the older read saw the store before the change
    await older;
    await settle();
    expect(ids(now(cache.read([alice], request())))).to.deep.equal(['a2']);
  });
});
