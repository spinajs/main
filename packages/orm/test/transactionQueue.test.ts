import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';

import { OrmDriver } from '../src/driver.js';
import { Builder } from '../src/builders.js';
import { IColumnDescriptor, ISupportedFeature, ITransactionContext, ITransactionOptions } from '../src/interfaces.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

class QueueTxDriver extends OrmDriver {
  public calls: string[] = [];

  private _failBegins: number;

  constructor(private readonly concurrent: boolean | undefined, failBegins = 0) {
    super({} as any);
    this._failBegins = failBegins;
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
    return this.concurrent === undefined ? { events: false, insertReturning: false } : { events: false, insertReturning: false, concurrentTransactions: this.concurrent };
  }

  public async tableInfo(_name: string, _schema?: string): Promise<IColumnDescriptor[]> {
    return [];
  }

  protected async _begin(_options?: ITransactionOptions): Promise<ITransactionContext> {
    this.calls.push('begin');
    await tick();

    if (this._failBegins > 0) {
      this._failBegins--;
      throw new Error('begin failed');
    }

    return { depth: 0 };
  }

  protected async _commit(_ctx: ITransactionContext): Promise<void> {
    this.calls.push('commit');
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

class FailingEndDriver extends QueueTxDriver {
  protected async _commit(ctx: ITransactionContext): Promise<void> {
    await super._commit(ctx);
    throw new Error('commit failed');
  }

  protected async _rollback(ctx: ITransactionContext): Promise<void> {
    await super._rollback(ctx);
    throw new Error('rollback failed');
  }
}

async function twoTransactions(d: QueueTxDriver): Promise<string[]> {
  const order: string[] = [];

  await Promise.all([
    d.transaction(async () => {
      order.push('a:start');
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push('a:end');
    }),
    d.transaction(async () => {
      order.push('b:start');
      order.push('b:end');
    }),
  ]);

  return order;
}

describe('OrmDriver outermost transaction queue', () => {
  it('runs outermost transactions one at a time when concurrentTransactions is false', async () => {
    const d = new QueueTxDriver(false);

    expect(await twoTransactions(d)).to.deep.equal(['a:start', 'a:end', 'b:start', 'b:end']);
    expect(d.calls).to.deep.equal(['begin', 'commit', 'dispose', 'begin', 'commit', 'dispose']);
  });

  it('lets outermost transactions overlap when the flag is unset or true', async () => {
    for (const concurrent of [undefined, true]) {
      const order = await twoTransactions(new QueueTxDriver(concurrent));

      expect(order.indexOf('b:end')).to.be.lessThan(order.indexOf('a:end'));
    }
  });

  it('starts the next transaction after one that failed', async () => {
    const d = new QueueTxDriver(false);

    const first = d.transaction(async () => {
      throw new Error('boom');
    });
    const second = d.transaction(async () => 'next');

    await expect(first).to.be.rejectedWith('boom');
    expect(await second).to.equal('next');
  });

  it('releases the queue when BEGIN fails', async () => {
    const d = new QueueTxDriver(false, 1);

    const first = d.transaction(async () => 'never');
    const second = d.transaction(async () => 'next');

    await expect(first).to.be.rejectedWith('begin failed');
    expect(await second).to.equal('next');
  });

  it('releases the queue when COMMIT and ROLLBACK fail', async () => {
    const d = new FailingEndDriver(false);

    const first = d.transaction(async () => 'never');
    const second = d.transaction(async () => {
      throw new Error('boom');
    });
    const third = d.transaction(async () => 'never');

    await expect(first).to.be.rejectedWith('commit failed');
    await expect(second).to.be.rejectedWith('boom');
    await expect(third).to.be.rejectedWith('commit failed');
    expect(d.calls).to.deep.equal(['begin', 'commit', 'rollback', 'dispose', 'begin', 'rollback', 'dispose', 'begin', 'commit', 'rollback', 'dispose']);
  });

  it('never queues a nested call', async () => {
    const d = new QueueTxDriver(false);

    expect(await d.transaction(async () => d.transaction(async () => 'inner'))).to.equal('inner');
    expect(d.calls).to.deep.equal(['begin', 'savepoint', 'releaseSavepoint', 'commit', 'dispose']);
  });

  it('lets an afterCommit callback open a transaction of its own', async () => {
    const d = new QueueTxDriver(false);
    let ranAfter = false;

    await d.transaction(async (tx) => {
      await tx.afterCommit(async () => {
        await d.transaction(async () => {
          ranAfter = true;
        });
      });
    });

    expect(ranAfter).to.equal(true);
  });
});
