import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';

import { OrmDriver } from '../src/driver.js';
import { Builder } from '../src/builders.js';
import { IColumnDescriptor, ISupportedFeature, ITransactionContext } from '../src/interfaces.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

const outcome = (transaction: Promise<unknown>) => transaction.then(() => 'committed', (err: Error) => err.message);

/** Statements go through withSessionSettings, as a dialect driver's executeOnDb does, and settle one macrotask later. */
class LevelTxDriver extends OrmDriver {
  public readonly calls: string[] = [];

  /** The savepoint whose SAVEPOINT statement fails, as on a lost connection. */
  public failSavepoint: string | undefined;

  constructor() {
    super({ Driver: 'level-tx', Name: 'level-tx' });
  }

  public statement(label: string, ticks = 1): Promise<void> {
    return this.withSessionSettings(async () => {
      this.calls.push(`${label}:start`);
      for (let i = 0; i < ticks; i++) await tick();
      this.calls.push(`${label}:end`);
    });
  }

  public async execute(_builder: Builder<unknown>): Promise<unknown[]> {
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

  protected async _begin(): Promise<ITransactionContext> {
    this.calls.push('begin');
    return { depth: 0 };
  }

  protected async _commit(_ctx: ITransactionContext): Promise<void> {
    this.calls.push('commit');
  }

  protected async _rollback(_ctx: ITransactionContext): Promise<void> {
    this.calls.push('rollback');
  }

  protected async _savepoint(_ctx: ITransactionContext, name: string): Promise<void> {
    this.calls.push(`savepoint ${name}`);
    await tick();
    if (name === this.failSavepoint) throw new Error(`savepoint ${name} failed`);
  }

  protected async _releaseSavepoint(_ctx: ITransactionContext, name: string): Promise<void> {
    this.calls.push(`release ${name}`);
  }

  protected async _rollbackToSavepoint(_ctx: ITransactionContext, name: string): Promise<void> {
    this.calls.push(`rollback to ${name}`);
  }

  protected async _dispose(_ctx: ITransactionContext): Promise<void> {
    this.calls.push('dispose');
  }
}

describe('OrmDriver savepoints take turns', () => {
  it('runs two savepoints started together one after the other', async () => {
    const d = new LevelTxDriver();

    await d.transaction(async () => {
      await Promise.all([
        d.transaction(async () => {
          await d.statement('a1');
          await d.statement('a2');
        }),
        d.transaction(async () => {
          await d.statement('b1');
        }),
      ]);
    });

    expect(d.calls).to.deep.equal(['begin', 'savepoint sp_1', 'a1:start', 'a1:end', 'a2:start', 'a2:end', 'release sp_1', 'savepoint sp_2', 'b1:start', 'b1:end', 'release sp_2', 'commit', 'dispose']);
  });

  it('holds a statement of the enclosing transaction until the open savepoint ends', async () => {
    const d = new LevelTxDriver();

    await d.transaction(async () => {
      await Promise.all([
        d.transaction(async () => {
          await d.statement('inner1');
          await d.statement('inner2');
        }),
        (async () => {
          await tick();
          await d.statement('outer');
        })(),
      ]);
    });

    expect(d.calls.indexOf('outer:start')).to.be.greaterThan(d.calls.indexOf('release sp_1'));
  });

  it('takes a savepoint only after the statements already running on its level settled', async () => {
    const d = new LevelTxDriver();

    await d.transaction(async () => {
      const running = d.statement('outer');
      await d.transaction(async () => {
        await d.statement('inner');
      });
      await running;
    });

    expect(d.calls.indexOf('savepoint sp_1')).to.be.greaterThan(d.calls.indexOf('outer:end'));
  });

  it('lets a savepoint open a savepoint of its own', async () => {
    const d = new LevelTxDriver();

    const result = await d.transaction(async () =>
      d.transaction(async () =>
        d.transaction(async () => {
          await d.statement('deepest');
          return 'done';
        }),
      ),
    );

    expect(result).to.equal('done');
    expect(d.calls).to.deep.equal(['begin', 'savepoint sp_1', 'savepoint sp_2', 'deepest:start', 'deepest:end', 'release sp_2', 'release sp_1', 'commit', 'dispose']);
  });

  it('holds a statement a finished savepoint left running like one of the enclosing transaction', async () => {
    const d = new LevelTxDriver();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let late: Promise<void> = Promise.resolve();

    await d.transaction(async () => {
      await d.transaction(async () => {
        late = gate.then(() => d.statement('late'));
      });
      await d.transaction(async () => {
        release();
        await tick();
        await d.statement('second');
      });
      await late;
    });

    expect(d.calls.indexOf('late:start')).to.be.greaterThan(d.calls.indexOf('release sp_2'));
  });

  it('ends the transaction only after the savepoints and statements still waiting for a turn ran', async () => {
    const d = new LevelTxDriver();
    let late: Promise<unknown>[] = [];

    const result = await outcome(
      d.transaction(async () => {
        const failing = d.transaction(async () => {
          await d.statement('a');
          throw new Error('a fails');
        });
        late = [d.transaction(async () => d.statement('b')), d.statement('outer')];
        await Promise.all([failing, ...late]);
      }),
    );

    expect(result).to.equal('a fails');
    expect((await Promise.allSettled(late)).map((s) => s.status)).to.deep.equal(['fulfilled', 'fulfilled']);
    expect(d.calls.indexOf('rollback')).to.be.greaterThan(d.calls.indexOf('release sp_2'));
    expect(d.calls.indexOf('rollback')).to.be.greaterThan(d.calls.indexOf('outer:end'));
  });

  it('runs a sibling still waiting behind a failed one before the rollback', async () => {
    const d = new LevelTxDriver();
    let third: Promise<void> = Promise.resolve();

    const result = await outcome(
      d.transaction(async () => {
        const first = d.transaction(() => d.statement('first'));
        const middle = d.transaction(async () => {
          await d.statement('middle');
          throw new Error('middle fails');
        });
        third = d.transaction(() => d.statement('third'));
        await Promise.all([first, middle, third]);
      }),
    );

    expect(result).to.equal('middle fails');
    await expect(third).to.be.fulfilled;
    expect(d.calls.slice(-7)).to.deep.equal(['rollback to sp_2', 'savepoint sp_3', 'third:start', 'third:end', 'release sp_3', 'rollback', 'dispose']);
  });

  it('lets a savepoint that is mid-statement finish before the rollback a failing sibling caused', async () => {
    const d = new LevelTxDriver();

    const result = await outcome(
      d.transaction(async () => {
        await Promise.all([
          d.transaction(() => d.statement('long', 3)),
          (async () => {
            await tick();
            await tick();
            throw new Error('validation fails');
          })(),
        ]);
      }),
    );

    expect(result).to.equal('validation fails');
    expect(d.calls.slice(-5)).to.deep.equal(['long:start', 'long:end', 'release sp_1', 'rollback', 'dispose']);
  });

  it('runs the savepoints a failing callback started and left waiting before the rollback', async () => {
    const d = new LevelTxDriver();
    const children: Promise<void>[] = [];

    await expect(
      d.transaction(async () => {
        children.push(d.transaction(() => d.statement('c1')), d.transaction(() => d.statement('c2')));
        throw new Error('body fails');
      }),
    ).to.be.rejectedWith('body fails');

    expect((await Promise.allSettled(children)).map((s) => s.status)).to.deep.equal(['fulfilled', 'fulfilled']);
    expect(d.calls.slice(-4)).to.deep.equal(['c2:end', 'release sp_2', 'rollback', 'dispose']);
  });

  it('commits only after a savepoint the callback started and did not await', async () => {
    const d = new LevelTxDriver();
    let child: Promise<string> = Promise.resolve('');

    await d.transaction(async () => {
      child = d.transaction(async () => {
        await d.statement('forgotten', 3);
        return 'child done';
      });
    });

    expect(await child).to.equal('child done');
    expect(d.calls).to.deep.equal(['begin', 'savepoint sp_1', 'forgotten:start', 'forgotten:end', 'release sp_1', 'commit', 'dispose']);
  });

  it('does not hold work that reaches the driver only after the transaction ended', async () => {
    const d = new LevelTxDriver();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let late: Promise<void> = Promise.resolve();

    await d.transaction(async () => {
      late = gate.then(() => d.statement('late'));
    });
    release();
    await late;

    expect(d.calls).to.deep.equal(['begin', 'commit', 'dispose', 'late:start', 'late:end']);
  });

  it('releases a savepoint only after a savepoint it started and did not await', async () => {
    const d = new LevelTxDriver();

    await d.transaction(async () => {
      await Promise.all([
        d.transaction(async () => {
          void d.transaction(() => d.statement('child', 3));
        }),
        d.transaction(() => d.statement('sibling')),
      ]);
    });

    expect(d.calls).to.deep.equal(['begin', 'savepoint sp_1', 'savepoint sp_2', 'child:start', 'child:end', 'release sp_2', 'release sp_1', 'savepoint sp_3', 'sibling:start', 'sibling:end', 'release sp_3', 'commit', 'dispose']);
  });

  it('hands the turn to exactly one waiting savepoint at a time, in call order', async () => {
    const d = new LevelTxDriver();
    let queued = 0;

    await d.transaction(async () => {
      await d.statement('first');
      const level = d.CurrentTransaction?.level;
      if (level === undefined) throw new Error('no level after a statement');
      const push = level.waiting.push.bind(level.waiting);
      level.waiting.push = (...entries) => {
        queued += entries.length;
        return push(...entries);
      };
      await Promise.all(Array.from({ length: 100 }, (_, i) => d.transaction(() => d.statement(`s${i}`))));
    });

    expect(d.calls.filter((c) => /^s\d+:start$/.test(c))).to.deep.equal(Array.from({ length: 100 }, (_, i) => `s${i}:start`));
    expect(d.calls.filter((c) => c.startsWith('savepoint '))).to.deep.equal(Array.from({ length: 100 }, (_, i) => `savepoint sp_${i + 1}`));
    expect(queued).to.equal(99);
  });

  it('hands the turn on in arrival order to statements and savepoints alike', async () => {
    const d = new LevelTxDriver();

    await d.transaction(async () => {
      await Promise.all([d.transaction(() => d.statement('a')), d.statement('s1'), d.transaction(() => d.statement('b')), d.statement('s2')]);
    });

    expect(d.calls).to.deep.equal(['begin', 'savepoint sp_1', 'a:start', 'a:end', 'release sp_1', 's1:start', 's1:end', 'savepoint sp_2', 'b:start', 'b:end', 'release sp_2', 's2:start', 's2:end', 'commit', 'dispose']);
  });

  it('passes the turn on when a waiting savepoint fails as it opens', async () => {
    const d = new LevelTxDriver();
    d.failSavepoint = 'sp_2';

    const outcomes = await d.transaction(() => Promise.allSettled([1, 2, 3].map((i) => d.transaction(() => d.statement(`s${i}`)))));

    expect(outcomes.map((o) => o.status)).to.deep.equal(['fulfilled', 'rejected', 'fulfilled']);
    expect(d.calls).to.deep.equal(['begin', 'savepoint sp_1', 's1:start', 's1:end', 'release sp_1', 'savepoint sp_2', 'savepoint sp_3', 's3:start', 's3:end', 'release sp_3', 'commit', 'dispose']);
  });

  it('waits before the commit for a statement that queued behind the drain', async () => {
    const d = new LevelTxDriver();
    let late: Promise<void> = Promise.resolve();

    await d.transaction(async () => {
      void d.transaction(() => d.statement('child', 3));
      late = (async () => {
        await tick();
        await d.statement('outer');
      })();
    });
    await late;

    expect(d.calls).to.deep.equal(['begin', 'savepoint sp_1', 'child:start', 'child:end', 'release sp_1', 'outer:start', 'outer:end', 'commit', 'dispose']);
  });
});
