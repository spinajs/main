import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { expect } from 'chai';
import { Deadline, KeyedMutex, TaskTracker, memoizeAsync, onceAsync, settleWithin, singleFlight } from '../src/index.js';

chai.use(chaiAsPromised);

const turn = () => new Promise<void>((r) => setImmediate(r));

function gate<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('async helpers', () => {
  describe('onceAsync', () => {
    it('shares one run between calls and keeps its result', async () => {
      let calls = 0;
      const init = onceAsync(async () => ++calls);
      expect(await Promise.all([init(), init()])).to.deep.eq([1, 1]);
      expect(await init()).to.eq(1);
      expect(calls).to.eq(1);
    });

    it('runs again after a rejection', async () => {
      let calls = 0;
      const init = onceAsync(async () => {
        if (++calls === 1) throw new Error('first');
        return calls;
      });
      await expect(init()).to.be.rejectedWith('first');
      expect(await init()).to.eq(2);
      expect(await init()).to.eq(2);
    });

    it('turns a synchronous throw into a rejection that is not kept', async () => {
      let calls = 0;
      const init = onceAsync((() => {
        if (++calls === 1) throw new Error('sync');
        return Promise.resolve(calls);
      }) as () => Promise<number>);
      await expect(init()).to.be.rejectedWith('sync');
      expect(await init()).to.eq(2);
    });
  });

  describe('memoizeAsync', () => {
    it('keeps a fulfilled promise under its key', async () => {
      const map = new Map<string, Promise<number>>();
      let calls = 0;
      const load = async () => ++calls;
      expect(await memoizeAsync(map, 'a', load)).to.eq(1);
      expect(await memoizeAsync(map, 'a', load)).to.eq(1);
      expect(await memoizeAsync(map, 'b', load)).to.eq(2);
      expect(map.size).to.eq(2);
    });

    it('evicts a rejected promise', async () => {
      const map = new Map<string, Promise<number>>();
      await expect(memoizeAsync(map, 'a', () => Promise.reject(new Error('no')))).to.be.rejectedWith('no');
      await turn();
      expect(map.has('a')).to.be.false;
      expect(await memoizeAsync(map, 'a', async () => 7)).to.eq(7);
    });

    it('does not evict a newer promise stored under the key', async () => {
      const map = new Map<string, Promise<number>>();
      const g = gate<number>();
      const first = memoizeAsync(map, 'a', () => g.promise);
      const replacement = Promise.resolve(9);
      map.set('a', replacement);
      g.reject(new Error('late'));
      await expect(first).to.be.rejected;
      await turn();
      expect(map.get('a')).to.eq(replacement);
    });
  });

  describe('singleFlight', () => {
    it('shares a load in flight and forgets it once it settles', async () => {
      const map = new Map<string, Promise<number>>();
      let calls = 0;
      const g = gate();
      const load = async () => {
        await g.promise;
        return ++calls;
      };
      const a = singleFlight(map, 'k', load);
      const b = singleFlight(map, 'k', load);
      expect(a).to.eq(b);
      g.resolve();
      expect(await a).to.eq(1);
      await turn();
      expect(map.size).to.eq(0);
      expect(await singleFlight(map, 'k', load)).to.eq(2);
    });

    it('forgets a rejected load', async () => {
      const map = new Map<string, Promise<number>>();
      await expect(singleFlight(map, 'k', () => Promise.reject(new Error('no')))).to.be.rejectedWith('no');
      await turn();
      expect(map.size).to.eq(0);
    });
  });

  describe('KeyedMutex', () => {
    it('runs tasks of one key one at a time, in call order', async () => {
      const mutex = new KeyedMutex<string>();
      const log: string[] = [];
      const g = gate();
      const first = mutex.runExclusive('k', async () => {
        log.push('first start');
        await g.promise;
        log.push('first end');
        return 1;
      });
      const second = mutex.runExclusive('k', async () => {
        log.push('second');
        return 2;
      });
      await turn();
      expect(log).to.deep.eq(['first start']);
      g.resolve();
      expect(await Promise.all([first, second])).to.deep.eq([1, 2]);
      expect(log).to.deep.eq(['first start', 'first end', 'second']);
    });

    it('runs different keys in parallel', async () => {
      const mutex = new KeyedMutex<string>();
      const g = gate();
      const blocked = mutex.runExclusive('a', () => g.promise);
      expect(await mutex.runExclusive('b', async () => 'free')).to.eq('free');
      g.resolve();
      await blocked;
    });

    it('a failed task does not stop the next one and the key is forgotten', async () => {
      const mutex = new KeyedMutex<string>();
      const failed = mutex.runExclusive('k', () => Promise.reject(new Error('boom')));
      const next = mutex.runExclusive('k', async () => 'ok');
      expect(mutex.size).to.eq(1);
      await expect(failed).to.be.rejectedWith('boom');
      expect(await next).to.eq('ok');
      expect(mutex.size).to.eq(0);
    });
  });

  describe('TaskTracker', () => {
    it('runs work on a later turn and drains it, including work deferred while draining', async () => {
      const tracker = new TaskTracker();
      const log: string[] = [];
      tracker.defer(async () => {
        log.push('a');
        tracker.defer(async () => {
          log.push('b');
        });
      });
      expect(log).to.deep.eq([]);
      expect(tracker.size).to.eq(1);
      await tracker.drain();
      expect(log).to.deep.eq(['a', 'b']);
      expect(tracker.size).to.eq(0);
    });

    it('reports a failure to onError and never to the caller', async () => {
      const errors: unknown[] = [];
      const tracker = new TaskTracker((err) => errors.push(err));
      const boom = new Error('boom');
      tracker.defer(() => Promise.reject(boom));
      tracker.defer(() => {
        throw new Error('sync');
      });
      await tracker.drain();
      expect(errors).to.have.length(2);
      expect(errors[0]).to.eq(boom);
    });

    it('ignores a throwing reporter', async () => {
      const tracker = new TaskTracker(() => {
        throw new Error('reporter');
      });
      tracker.defer(() => Promise.reject(new Error('boom')));
      await tracker.drain();
      expect(tracker.size).to.eq(0);
    });
  });

  describe('settleWithin', () => {
    it('reports a fulfilled promise', async () => {
      expect(await settleWithin(Promise.resolve(3), 50)).to.deep.eq({ status: 'fulfilled', value: 3 });
    });

    it('reports a rejection with its reason', async () => {
      const err = new Error('no');
      expect(await settleWithin(Promise.reject(err), 50)).to.deep.eq({ status: 'rejected', reason: err });
    });

    it('reports a timeout and ignores a later rejection', async () => {
      const g = gate();
      expect(await settleWithin(g.promise, 5)).to.deep.eq({ status: 'timeout' });
      g.reject(new Error('late'));
      await turn();
    });

    it('marks a thenable whose then() throws', async () => {
      const err = new Error('broken');
      const broken = {
        then() {
          throw err;
        },
      };
      expect(await settleWithin(broken, 50)).to.deep.eq({ status: 'rejected', reason: err, brokenThenable: true });
    });
  });

  describe('Deadline', () => {
    it('passes a result through before the limit', async () => {
      const deadline = new Deadline(50);
      expect(await deadline.race(Promise.resolve('ok'))).to.eq('ok');
      expect(deadline.expired).to.be.false;
      deadline.clear();
    });

    it('answers EXPIRED once the limit is reached, for later races too', async () => {
      const deadline = new Deadline(5);
      const g = gate<string>();
      expect(await deadline.race(g.promise)).to.eq(Deadline.EXPIRED);
      expect(deadline.expired).to.be.true;
      expect(await deadline.race(Promise.reject(new Error('swallowed')))).to.eq(Deadline.EXPIRED);
      g.resolve('late');
      deadline.clear();
    });

    it('clear() stops the timer', async () => {
      const deadline = new Deadline(5);
      deadline.clear();
      await new Promise((r) => setTimeout(r, 15));
      expect(deadline.expired).to.be.false;
    });
  });
});
