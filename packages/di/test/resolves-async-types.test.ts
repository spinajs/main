import 'mocha';
import { expect } from 'chai';

import { AsyncService, Autoinject, DI, isPromise, ResolvesAsync } from '../src/index.js';

// Compile-level checks: ts-node type-checks this file, so a wrong resolve type fails the suite.
const expectType = <T>(_value: T) => undefined;

class Transport extends AsyncService {
  public async resolve() {
    await new Promise((resolve) => setTimeout(resolve, 1));
    await super.resolve();
  }
}

abstract class Job {
  declare readonly [ResolvesAsync]: true;
}

class Worker extends Job {
  @Autoinject(Transport)
  public Transport: Transport;

  public run() {
    return this.Transport.Resolved;
  }
}

class SyncJob extends Job {}

class Clock {
  public now() {
    return 1;
  }
}

function resolveTypes() {
  // @ts-expect-error a class marked ResolvesAsync may resolve to a promise
  DI.resolve(Worker).run();
  // @ts-expect-error the same through a container
  DI.child().resolve(Worker).run();
  // @ts-expect-error a list of a marked base may be a promise
  DI.resolve(Array.ofType(Job)).map((j) => j);
  // @ts-expect-error a chain of any non-AsyncService base may be a promise
  DI.resolve(Array.chainOf(Job)).map((j) => j);

  // @ts-expect-error a cached marked class comes back as the instance, so a resolve is not always a promise
  void DI.resolve(Worker).then((w) => w.run());
  // @ts-expect-error the same for a list of a marked base
  const jobs: Promise<Job[]> = DI.resolve(Array.ofType(Job));
  void jobs;

  expectType<Worker | Promise<Worker>>(DI.resolve(Worker));
  expectType<Worker | Promise<Worker>>(DI.child().resolve(Worker));
  expectType<Job[] | Promise<Job[]>>(DI.resolve(Array.ofType(Job)));
  expectType<Job[] | Promise<Job[]>>(DI.resolve(Array.chainOf(Job)));
  expectType<Promise<Transport>>(DI.resolve(Transport));
  expectType<Clock>(DI.resolve(Clock));
  expectType<Clock[]>(DI.resolve(Array.ofType(Clock)));
}

describe('resolve types of classes that resolve asynchronously', () => {
  afterEach(() => {
    DI.clear();
  });

  it('compile', () => {
    expect(resolveTypes).to.be.a('function');
  });

  it('a marked class is a promise while its dependencies resolve, the instance once cached', async () => {
    const first = DI.resolve(Worker);
    expect(isPromise(first)).to.equal(true);
    expect((await first).run()).to.equal(true);

    expect(DI.resolve(Worker)).to.be.instanceOf(Worker);
  });

  it('a list of a marked base is a promise on the first resolve, an array once cached or when empty', async () => {
    expect(DI.resolve(Array.ofType(Job))).to.deep.equal([]);

    DI.register(SyncJob).as(Job);
    DI.register(Worker).as(Job);

    const first = DI.resolve(Array.ofType(Job));
    expect(isPromise(first)).to.equal(true);
    expect((await first).map((j) => j.constructor)).to.deep.equal([SyncJob, Worker]);

    expect(Array.isArray(DI.resolve(Array.ofType(Job)))).to.equal(true);
  });

  it('a chain of a marked base is a promise on the first resolve, an array once cached or when empty', async () => {
    expect(DI.resolve(Array.chainOf(Job))).to.deep.equal([]);

    DI.register(Worker).as(Job);

    const first = DI.resolve(Array.chainOf(Job));
    expect(isPromise(first)).to.equal(true);
    await first;

    expect(Array.isArray(DI.resolve(Array.chainOf(Job)))).to.equal(true);
  });

  it('the marker is a declaration only', () => {
    expect(Object.getOwnPropertySymbols(DI.resolve(SyncJob))).to.not.include(ResolvesAsync);
  });
});
