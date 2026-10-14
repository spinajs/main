/* eslint-disable prettier/prettier */
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';

import { OrmDriver } from '../src/driver.js';
import { Builder } from '../src/builders.js';
import { IColumnDescriptor, ISupportedFeature, ITransactionContext, ITransactionOptions, IsolationLevel } from '../src/interfaces.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

interface IFakeTxDriverOptions {
  failCommit?: boolean;
  supported?: IsolationLevel[];
}

/**
 * Records every transaction primitive the base class invokes, so the tests can assert the
 * exact lifecycle rather than guessing at it.
 */
class FakeTxDriver extends OrmDriver {
  public calls: string[] = [];
  public readonly SupportedIsolationLevels: IsolationLevel[];

  private _failCommit: boolean;

  constructor(opts?: IFakeTxDriverOptions) {
    super({} as any);
    this._failCommit = opts?.failCommit ?? false;
    this.SupportedIsolationLevels = opts?.supported ?? ['READ UNCOMMITTED', 'READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'];
  }

  public async execute(_builder: Builder<any>): Promise<any> {
    return [];
  }

  public async ping(): Promise<boolean> {
    return true;
  }

  public async connect(): Promise<OrmDriver> {
    return this;
  }

  public async disconnect(): Promise<OrmDriver> {
    return this;
  }

  public supportedFeatures(): ISupportedFeature {
    return { events: false, insertReturning: false };
  }

  public async tableInfo(_name: string, _schema?: string): Promise<IColumnDescriptor[]> {
    return [];
  }

  protected async _begin(_options?: ITransactionOptions): Promise<ITransactionContext> {
    this.calls.push('begin');
    return { depth: 0 };
  }

  protected async _commit(_ctx: ITransactionContext): Promise<void> {
    this.calls.push('commit');
    if (this._failCommit) {
      throw new Error('commit failed');
    }
  }

  protected async _rollback(_ctx: ITransactionContext): Promise<void> {
    this.calls.push('rollback');
  }

  protected async _savepoint(_ctx: ITransactionContext, _name: string): Promise<void> {
    this.calls.push('savepoint');
  }

  protected async _releaseSavepoint(_ctx: ITransactionContext, _name: string): Promise<void> {
    this.calls.push('releaseSavepoint');
  }

  protected async _rollbackToSavepoint(_ctx: ITransactionContext, _name: string): Promise<void> {
    this.calls.push('rollbackToSavepoint');
  }

  protected async _dispose(_ctx: ITransactionContext): Promise<void> {
    this.calls.push('dispose');
  }
}

describe('OrmDriver transaction contract ( F2, B24 )', () => {
  it('commits when the callback resolves', async () => {
    const d = new FakeTxDriver();
    const r = await d.transaction(async () => 'value');

    expect(r).to.equal('value');
    expect(d.calls).to.deep.equal(['begin', 'commit', 'dispose']);
  });

  it('rolls back and rethrows when the callback throws', async () => {
    const d = new FakeTxDriver();

    await expect(
      d.transaction(async () => {
        throw new Error('boom');
      }),
    ).to.be.rejectedWith('boom');

    expect(d.calls).to.deep.equal(['begin', 'rollback', 'dispose']);
  });

  it('disposes the connection exactly once even when commit fails', async () => {
    const d = new FakeTxDriver({ failCommit: true });

    await expect(d.transaction(async () => 1)).to.be.rejected;

    expect(d.calls.filter((c) => c === 'dispose')).to.have.length(1);
  });

  it('nests via savepoints', async () => {
    const d = new FakeTxDriver();

    await d.transaction(async () => {
      await d.transaction(async () => 'inner');
    });

    expect(d.calls).to.deep.equal(['begin', 'savepoint', 'releaseSavepoint', 'commit', 'dispose']);
  });

  it('rolls the inner savepoint back without discarding the outer transaction', async () => {
    const d = new FakeTxDriver();

    await d.transaction(async () => {
      await d
        .transaction(async () => {
          throw new Error('inner fails');
        })
        .catch(() => undefined);
    });

    expect(d.calls).to.deep.equal(['begin', 'savepoint', 'rollbackToSavepoint', 'commit', 'dispose']);
  });

  it('rejects an isolation level the driver does not support', async () => {
    const d = new FakeTxDriver({ supported: ['READ COMMITTED'] });

    await expect(d.transaction(async () => 1, { isolation: 'SERIALIZABLE' })).to.be.rejected;
    expect(d.calls).to.deep.equal([]);
  });

  it('exposes the ambient transaction context to code running inside the callback', async () => {
    const d = new FakeTxDriver();

    expect(d.CurrentTransaction).to.be.undefined;

    await d.transaction(async () => {
      expect(d.CurrentTransaction).to.not.be.undefined;
      expect(d.CurrentTransaction!.depth).to.equal(0);
    });

    expect(d.CurrentTransaction).to.be.undefined;
  });
});

describe('OrmDriver.afterCommit ( decision 18 )', () => {
  /** A FakeTxDriver whose log records error messages ( `resolve()`, which sets the real one, never runs here ). */
  const driver = (opts?: IFakeTxDriverOptions): { d: FakeTxDriver; errors: string[] } => {
    const d = new FakeTxDriver(opts);
    const errors: string[] = [];
    (d as unknown as { Log: unknown }).Log = { error: (message: string) => errors.push(message) };
    return { d, errors };
  };

  it('runs the callback at once when no transaction is open', async () => {
    const { d } = driver();

    await d.afterCommit(() => {
      d.calls.push('cb');
    });

    expect(d.calls).to.deep.equal(['cb']);
  });

  it('runs callbacks after the outermost commit, in registration order, outside the transaction', async () => {
    const { d } = driver();
    const seen: unknown[] = [];

    const result = await d.transaction(async () => {
      await d.afterCommit(() => {
        d.calls.push('first');
        seen.push(d.CurrentTransaction);
      });
      await d.afterCommit(async () => {
        d.calls.push('second');
      });
      d.calls.push('body');
      return 'value';
    });

    expect(result).to.equal('value');
    expect(d.calls).to.deep.equal(['begin', 'body', 'commit', 'dispose', 'first', 'second']);
    expect(seen).to.deep.equal([undefined]);
  });

  it('runs a callback queued in a released savepoint only after the outermost commit', async () => {
    const { d } = driver();

    await d.transaction(async () => {
      await d.transaction(async () => {
        await d.afterCommit(() => {
          d.calls.push('inner');
        });
      });
      d.calls.push('after savepoint');
    });

    expect(d.calls).to.deep.equal(['begin', 'savepoint', 'releaseSavepoint', 'after savepoint', 'commit', 'dispose', 'inner']);
  });

  it('drops every callback when the outermost transaction rolls back', async () => {
    const { d } = driver();

    await expect(
      d.transaction(async () => {
        await d.afterCommit(() => {
          d.calls.push('cb');
        });
        throw new Error('boom');
      }),
    ).to.be.rejectedWith('boom');

    expect(d.calls).to.deep.equal(['begin', 'rollback', 'dispose']);
  });

  it('drops every callback when the commit fails', async () => {
    const { d } = driver({ failCommit: true });

    await expect(
      d.transaction(async () => {
        await d.afterCommit(() => {
          d.calls.push('cb');
        });
      }),
    ).to.be.rejectedWith('commit failed');

    expect(d.calls).to.not.include('cb');
  });

  it('drops only the callbacks queued since a savepoint began when it rolls back', async () => {
    const { d } = driver();

    await d.transaction(async () => {
      await d.afterCommit(() => {
        d.calls.push('before');
      });
      await d
        .transaction(async () => {
          await d.afterCommit(() => {
            d.calls.push('inside');
          });
          await d.transaction(async () => {
            await d.afterCommit(() => {
              d.calls.push('nested released');
            });
          });
          throw new Error('savepoint fails');
        })
        .catch(() => undefined);
      await d.afterCommit(() => {
        d.calls.push('after');
      });
    });

    expect(d.calls.filter((c) => !['begin', 'savepoint', 'releaseSavepoint', 'rollbackToSavepoint', 'commit', 'dispose'].includes(c))).to.deep.equal(['before', 'after']);
  });

  it('logs a failing callback, never rethrows it, and still runs the next one', async () => {
    const { d, errors } = driver();

    const result = await d.transaction(async () => {
      await d.afterCommit(() => {
        throw new Error('publish failed');
      });
      await d.afterCommit(() => {
        d.calls.push('next');
      });
      return 1;
    });
    await d.afterCommit(async () => {
      throw new Error('immediate failed');
    });

    expect(result).to.equal(1);
    expect(d.calls).to.include('next');
    expect(errors).to.have.length(2);
    expect(errors[0]).to.include('publish failed');
    expect(errors[1]).to.include('immediate failed');
  });
});
