import 'mocha';
import { expect } from 'chai';

import { ConcurrencyLimiter } from '../src/limiter.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((res) => setImmediate(res));

describe('ConcurrencyLimiter', () => {
  it('runs at most max tasks at once and starts the rest in FIFO order', async () => {
    const limiter = new ConcurrencyLimiter(2);
    const gates = Array.from({ length: 5 }, () => deferred());
    const started: number[] = [];
    const runs = gates.map((g, i) =>
      limiter.run(async () => {
        started.push(i);
        await g.promise;
        return i;
      }),
    );

    await tick();
    expect(started).to.deep.equal([0, 1]);
    expect(limiter.active).to.equal(2);
    expect(limiter.queued).to.equal(3);

    gates[1].resolve();
    await tick();
    expect(started).to.deep.equal([0, 1, 2]);

    gates[0].resolve();
    await tick();
    expect(started).to.deep.equal([0, 1, 2, 3]);

    gates.forEach((g) => g.resolve());
    expect(await Promise.all(runs)).to.deep.equal([0, 1, 2, 3, 4]);
    expect(limiter.peak).to.equal(2);
    expect(limiter.active).to.equal(0);
    expect(limiter.runs).to.equal(5);
  });

  it('hands a released slot to the waiter, not to a newcomer arriving in the same microtask turn', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const started: string[] = [];
    let maxActive = 0;
    const gate = deferred();
    const task = (name: string, wait?: Promise<void>) => () => {
      started.push(name);
      maxActive = Math.max(maxActive, limiter.active);
      return wait ?? Promise.resolve();
    };

    const a = limiter.run(task('a', gate.promise));
    const b = limiter.run(task('b'));
    let c!: Promise<void>;
    gate.resolve();
    queueMicrotask(() => {
      c = limiter.run(task('c'));
    });
    await a;
    await b;
    await tick();
    await c;

    expect(started).to.deep.equal(['a', 'b', 'c']);
    expect(maxActive).to.equal(1);
  });

  it('frees the slot when a task fails', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const failed = limiter.run(async () => {
      throw new Error('boom');
    });
    const next = limiter.run(async () => 'ok');
    let error: unknown;
    try {
      await failed;
    } catch (e) {
      error = e;
    }
    expect((error as Error).message).to.equal('boom');
    expect(await next).to.equal('ok');
    expect(limiter.active).to.equal(0);
  });

  it('refuses a max below 1', () => {
    expect(() => new ConcurrencyLimiter(0)).to.throw();
    expect(() => new ConcurrencyLimiter(1.5)).to.throw();
  });
});
