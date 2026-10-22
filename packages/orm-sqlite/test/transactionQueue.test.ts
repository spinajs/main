import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Orm, QueryContext } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function names(): Promise<string[]> {
  return (await driver().select().from('gap_tx').orderBy('Id').asRaw<{ Name: string }[]>()).map((r) => r.Name);
}

/** Opens a transaction that inserts `inside`, then waits for `finish()` and rolls back. */
function rolledBackTransaction() {
  let opened!: () => void;
  const isOpen = new Promise<void>((resolve) => (opened = resolve));
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));

  const outcome = driver()
    .transaction(async () => {
      await driver().insert().into('gap_tx').values({ Name: 'inside' });
      opened();
      await finished;
      throw new Error('roll back');
    })
    .then(
      () => 'committed',
      (err: Error) => err.message,
    );

  return { isOpen, finish, outcome };
}

describe('sqlite transaction serialisation', function () {
  this.timeout(10000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await driver()
      .schema()
      .createTable('gap_tx', (table) => {
        table.int('Id').primaryKey().autoIncrement();
        table.string('Name');
      });
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('reports no concurrent transactions', () => {
    expect(driver().supportedFeatures().concurrentTransactions).to.eq(false);
  });

  it('runs two concurrent outermost transactions one after the other, both committed', async () => {
    const order: string[] = [];

    await Promise.all([
      driver().transaction(async () => {
        order.push('a:start');
        await driver().insert().into('gap_tx').values({ Name: 'a' });
        await sleep(20);
        order.push('a:end');
      }),
      driver().transaction(async () => {
        order.push('b:start');
        await driver().insert().into('gap_tx').values({ Name: 'b' });
        order.push('b:end');
      }),
    ]);

    expect(order).to.deep.eq(['a:start', 'a:end', 'b:start', 'b:end']);
    expect(await names()).to.deep.eq(['a', 'b']);
  });

  it('holds a write from another async path until the open transaction ends, so it is not rolled back with it', async () => {
    const tx = rolledBackTransaction();
    await tx.isOpen;

    let outsideDone = false;
    const outside = (async () => {
      await driver().insert().into('gap_tx').values({ Name: 'outside' }).execute();
      outsideDone = true;
    })();

    await sleep(30);
    expect(outsideDone, 'the outside write ran inside the open transaction').to.eq(false);

    tx.finish();
    expect(await tx.outcome).to.eq('roll back');
    await outside;
    expect(await names()).to.deep.eq(['outside']);
  });

  it('holds a read from another async path, so it never sees uncommitted rows', async () => {
    const tx = rolledBackTransaction();
    await tx.isOpen;

    const read = names();
    await sleep(30);

    tx.finish();
    await tx.outcome;
    expect(await read).to.deep.eq([]);
  });

  // sqlite3 runs the statements of one handle in parallel, so a write submitted just before BEGIN
  // can still land inside the transaction; the race shows in a few of every few hundred rounds
  it('lets a write submitted just before BEGIN finish outside the transaction', async () => {
    const lost: number[] = [];

    for (let i = 0; i < 500; i++) {
      const outside = driver().insert().into('gap_tx').values({ Name: `outside-${i}` }).execute();
      const tx = driver()
        .transaction(async () => {
          throw new Error('roll back');
        })
        .catch(() => undefined);
      await Promise.all([outside, tx]);

      if ((await driver().select().from('gap_tx').where('Name', `outside-${i}`).asRaw<unknown[]>()).length === 0) {
        lost.push(i);
      }
    }

    expect(lost).to.deep.eq([]);
  });

  it('lets an afterCommit callback open a transaction of its own', async () => {
    await driver().transaction(async (tx) => {
      await tx.insert().into('gap_tx').values({ Name: 'main' });
      await tx.afterCommit(async () => {
        await driver().transaction(async () => {
          await driver().insert().into('gap_tx').values({ Name: 'after' });
        });
      });
    });

    expect(await names()).to.deep.eq(['main', 'after']);
  });

  it('keeps statements issued after a timer or inside Promise.all in the transaction', async () => {
    const outcome = await driver()
      .transaction(async () => {
        await sleep(5);
        await Promise.all([driver().insert().into('gap_tx').values({ Name: 'a' }), driver().insert().into('gap_tx').values({ Name: 'b' })]);
        await new Promise<void>((resolve) => setImmediate(resolve));
        await driver().insert().into('gap_tx').values({ Name: 'c' });
        throw new Error('roll back');
      })
      .then(
        () => 'committed',
        (err: Error) => err.message,
      );

    expect(outcome).to.eq('roll back');
    expect(await names()).to.deep.eq([]);
  });

  it('lets an afterCommit callback write outside a transaction', async () => {
    await driver().transaction(async (tx) => {
      await tx.insert().into('gap_tx').values({ Name: 'main' });
      await tx.afterCommit(async () => {
        await driver().insert().into('gap_tx').values({ Name: 'after' });
      });
    });

    expect(await names()).to.deep.eq(['main', 'after']);
  });

  it('releases the gate and the queue when BEGIN fails', async () => {
    const d = driver() as unknown as { beginStatement: () => string };
    const original = d.beginStatement;
    d.beginStatement = function (this: unknown) {
      d.beginStatement = original;
      return 'BEGIN NONSENSE';
    };

    const failed = driver()
      .transaction(async () => 'never')
      .then(
        () => 'committed',
        (err: Error) => err.message,
      );

    expect(await failed).to.match(/syntax error/);
    await driver().insert().into('gap_tx').values({ Name: 'outside' });
    await driver().transaction(async () => {
      await driver().insert().into('gap_tx').values({ Name: 'next' });
    });
    expect(await names()).to.deep.eq(['outside', 'next']);
  });

  it('releases the gate and the queue when COMMIT fails', async () => {
    await driver().executeOnDb('PRAGMA foreign_keys = ON', [], QueryContext.Schema);
    await driver().executeOnDb('CREATE TABLE gap_parent (Id INTEGER PRIMARY KEY)', [], QueryContext.Schema);
    await driver().executeOnDb('CREATE TABLE gap_child (Id INTEGER PRIMARY KEY, ParentId INTEGER REFERENCES gap_parent (Id) DEFERRABLE INITIALLY DEFERRED)', [], QueryContext.Schema);

    const failed = driver()
      .transaction(async () => {
        await driver().insert().into('gap_child').values({ ParentId: 404 });
      })
      .then(
        () => 'committed',
        (err: Error) => err.message,
      );

    expect(await failed).to.match(/FOREIGN KEY constraint failed/);
    await driver().insert().into('gap_tx').values({ Name: 'outside' });
    await driver().transaction(async () => {
      await driver().insert().into('gap_tx').values({ Name: 'next' });
    });
    expect(await names()).to.deep.eq(['outside', 'next']);
    expect(await driver().select().from('gap_child').asRaw()).to.deep.eq([]);
  });

  it('runs a nested transaction as a savepoint without waiting', async () => {
    expect(await driver().transaction(async () => driver().transaction(async () => 'inner'))).to.eq('inner');
  });
});
