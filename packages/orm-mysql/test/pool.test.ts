import { expect } from 'chai';
import 'mocha';
import { MySqlOrmDriver } from '../src/index.js';

class ProbeDriver extends MySqlOrmDriver {
  public probe() {
    return (this as any).resolvedPoolOptions();
  }
}

describe('pool metrics', () => {
  it('reports zeros before the pool exists rather than throwing', () => {
    const d = new ProbeDriver({ Driver: 'orm-driver-mysql', Name: 'x' } as any);

    expect(d.poolMetrics()).to.deep.equal({ Size: 0, InUse: 0, Waiting: 0 });
  });

  it('reads mysql2s internal pool bookkeeping', () => {
    const d = new ProbeDriver({ Driver: 'orm-driver-mysql', Name: 'x' } as any);
    (d as any).Pool = {
      _allConnections: [1, 2, 3, 4],
      _freeConnections: [1],
      _connectionQueue: [1, 2],
    };

    expect(d.poolMetrics()).to.deep.equal({ Size: 4, InUse: 3, Waiting: 2 });
  });

  it('degrades to zeros when mysql2 renames its internals', () => {
    const d = new ProbeDriver({ Driver: 'orm-driver-mysql', Name: 'x' } as any);
    (d as any).Pool = {};

    expect(d.poolMetrics()).to.deep.equal({ Size: 0, InUse: 0, Waiting: 0 });
  });
});

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
