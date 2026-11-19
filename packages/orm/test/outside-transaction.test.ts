import 'mocha';
import { expect } from 'chai';
import { FakeSqliteDriver } from './misc.js';

class ProbeDriver extends FakeSqliteDriver {
  public probe<R>(fn: () => R): R {
    return this.outsideTransaction(fn);
  }
}

const driver = () => new ProbeDriver({ Name: 'probe', Driver: 'sqlite' });

describe('OrmDriver.outsideTransaction', () => {
  it('hides the ambient transaction from synchronous and deferred work', async () => {
    const d = driver();

    await d.transaction(async () => {
      expect(d.CurrentTransaction).to.not.equal(undefined);
      expect(d.probe(() => d.CurrentTransaction)).to.equal(undefined);

      const later = await d.probe(async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        return d.CurrentTransaction;
      });
      expect(later).to.equal(undefined);

      expect(d.CurrentTransaction).to.not.equal(undefined);
    });
  });

  it('is needed: setImmediate alone stays inside the transaction', async () => {
    const d = driver();
    let seen: unknown;

    await d.transaction(async () => {
      await new Promise<void>((resolve) =>
        setImmediate(() => {
          seen = d.CurrentTransaction;
          resolve();
        }),
      );
    });

    expect(seen).to.not.equal(undefined);
  });
});
