import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { AsyncService, Autoinject, DI, Inject } from '../src/index.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

class BootError extends Error {}

class FailingBoot extends AsyncService {
  public async resolve() {
    await new Promise((r) => setTimeout(r, 5));
    throw new BootError('boot failed');
  }
}

class NeedsFailingBoot extends AsyncService {
  @Autoinject(FailingBoot)
  public Boot: FailingBoot;
}

class ThrowsInConstructor {
  constructor() {
    throw new Error('constructor failed');
  }
}

/** Collects the unhandled rejections from `fn` until its timers have run. */
async function unhandledDuring(fn: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 30));
    await new Promise((r) => setImmediate(r));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  return unhandled;
}

describe('a rejected AsyncService resolve', () => {
  afterEach(() => {
    DI.clearCache();
  });

  it('rejects the resolve with the original error', async () => {
    const unhandled = await unhandledDuring(async () => {
      await expect(DI.resolve(FailingBoot)).to.be.rejectedWith(BootError, 'boot failed');
    });
    expect(unhandled).to.deep.equal([]);
  });

  it('rejects the resolve of a service that depends on it', async () => {
    const unhandled = await unhandledDuring(async () => {
      await expect(DI.resolve(NeedsFailingBoot)).to.be.rejectedWith(BootError, 'boot failed');
    });
    expect(unhandled).to.deep.equal([]);
  });

  it('caches nothing, so the next resolve tries again', async () => {
    await expect(DI.resolve(FailingBoot)).to.be.rejectedWith(BootError);
    expect(DI.has(FailingBoot)).to.equal(false);
    await expect(DI.resolve(FailingBoot)).to.be.rejectedWith(BootError);
  });

  it('is not left unhandled when a later property dependency throws synchronously', async () => {
    class Holder {
      @Autoinject(FailingBoot)
      public Boot: FailingBoot;

      @Autoinject(ThrowsInConstructor)
      public Broken: ThrowsInConstructor;
    }

    const unhandled = await unhandledDuring(async () => {
      expect(() => DI.resolve(Holder)).to.throw('constructor failed');
    });
    expect(unhandled).to.deep.equal([]);
  });

  it('is not left unhandled when a later constructor dependency throws synchronously', async () => {
    @Inject(FailingBoot, ThrowsInConstructor)
    class Holder {
      constructor(
        public boot: FailingBoot,
        public broken: ThrowsInConstructor,
      ) {}
    }

    const unhandled = await unhandledDuring(async () => {
      expect(() => DI.resolve(Holder)).to.throw('constructor failed');
    });
    expect(unhandled).to.deep.equal([]);
  });
});
