import { expect } from 'chai';
import 'mocha';
import { MySqlOrmDriver } from '../src/index.js';

class ProbeDriver extends MySqlOrmDriver {
  public probe() {
    return (this as any).resolvedPoolOptions();
  }
}

describe('pool options', () => {
  it('defaults when nothing is configured', () => {
    const d = new ProbeDriver({ Driver: 'orm-driver-mysql', Name: 'x' } as any);

    expect(d.probe()).to.deep.equal({ Min: 0, Max: 10, IdleTimeout: 30000, AcquireTimeout: 10000 });
  });

  it('honours the deprecated PoolLimit as Max', () => {
    const d = new ProbeDriver({ Driver: 'orm-driver-mysql', Name: 'x', PoolLimit: 3 } as any);

    expect(d.probe().Max).to.equal(3);
  });

  it('Pool.Max wins over PoolLimit', () => {
    const d = new ProbeDriver({ Driver: 'orm-driver-mysql', Name: 'x', PoolLimit: 3, Pool: { Max: 7 } } as any);

    expect(d.probe().Max).to.equal(7);
  });

  it('carries every configured field through', () => {
    const d = new ProbeDriver({
      Driver: 'orm-driver-mysql',
      Name: 'x',
      Pool: { Min: 2, Max: 20, IdleTimeout: 1000, AcquireTimeout: 500 },
    } as any);

    expect(d.probe()).to.deep.equal({ Min: 2, Max: 20, IdleTimeout: 1000, AcquireTimeout: 500 });
  });
});
