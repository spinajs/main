import * as chai from 'chai';
import 'mocha';
import { OrmException } from '@spinajs/orm';

import './migrations/PgTypesMigration_2026_10_15_00_02_00.js';
import { IPgSuite, openSuite, sqlState } from './harness.js';
import { PgTxUser } from './models/types.js';

const expect = chai.expect;

describe('postgres integration - a transaction aborted by a caught statement error', function () {
  let suite: IPgSuite;

  const names = async () => (await suite.raw<{ Name: string }[]>('SELECT "Name" FROM "pg_tx_user" ORDER BY "Name"')).map((r) => r.Name);
  const backend = async () => (await suite.raw<{ pid: number }[]>('SELECT pg_backend_pid() AS pid'))[0].pid;

  before(async function () {
    // One connection: the client of the refused commit is the one every later statement gets.
    suite = await openSuite(this, { name: 'tx_aborted', pool: { Max: 1 } });
  });

  beforeEach(async () => {
    await suite.reset('pg_tx_user');
  });

  after(async () => {
    await suite?.close();
  });

  it('rejects, writes nothing and runs no afterCommit callback when a caught failed statement aborted it', async () => {
    const ran: string[] = [];
    let pid = 0;

    const err = await suite.driver
      .transaction(async () => {
        pid = await backend();
        await PgTxUser.create({ Name: 'lost' });
        await suite.driver.afterCommit(() => {
          ran.push('afterCommit');
        });
        await suite.raw('SELECT * FROM "no_such_table"').catch(() => undefined);
        return 'the-value';
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(err).to.be.instanceOf(OrmException);
    expect((err as Error).message).to.include('aborted by an earlier failed statement');
    expect(sqlState((err as OrmException).inner)).to.equal('42P01');
    expect((err as Error).message).to.include('no_such_table');
    expect(ran).to.deep.equal([]);
    expect(await names()).to.deep.equal([]);

    // the pooled client left the aborted transaction: the same backend runs the next statement outside any transaction
    expect(await backend()).to.equal(pid);
    const [{ txid }] = await suite.raw<{ txid: string | null }[]>('SELECT txid_current_if_assigned() AS txid');
    expect(txid).to.equal(null);
    expect(suite.driver.CurrentTransaction).to.equal(undefined);

    await suite.driver.transaction(async () => {
      await PgTxUser.create({ Name: 'next' });
      await suite.driver.afterCommit(() => {
        ran.push('next');
      });
    });
    expect(await names()).to.deep.equal(['next']);
    expect(ran).to.deep.equal(['next']);
    expect(suite.driver.poolMetrics().InUse).to.equal(0);
  });

  it('commits when the failed statement was rolled back to its savepoint, and runs the callbacks queued outside it', async () => {
    const ran: string[] = [];

    await suite.driver.transaction(async () => {
      await PgTxUser.create({ Name: 'outer' });
      await suite.driver.afterCommit(() => {
        ran.push('outer');
      });
      await suite.driver
        .transaction(async () => {
          await suite.driver.afterCommit(() => {
            ran.push('inner');
          });
          await suite.raw('SELECT * FROM "no_such_table"');
        })
        .catch(() => undefined);
    });

    expect(await names()).to.deep.equal(['outer']);
    expect(ran).to.deep.equal(['outer']);
  });

  it('names the later failure, not one rolled back to its savepoint, when a commit is refused', async () => {
    const err = await suite.driver
      .transaction(async () => {
        await PgTxUser.create({ Name: 'lost' });
        await suite.driver
          .transaction(async () => {
            await suite.raw('SELECT * FROM "no_such_table"');
          })
          .catch(() => undefined);
        await suite.raw('SELECT "no_such_column" FROM "pg_tx_user"').catch(() => undefined);
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(err).to.be.instanceOf(OrmException);
    expect(sqlState((err as OrmException).inner)).to.equal('42703');
    expect((err as Error).message).to.include('no_such_column');
    expect((err as Error).message).to.not.include('no_such_table');
    expect(await names()).to.deep.equal([]);
  });

  it('commits a transaction without a failed statement as before', async () => {
    const ran: string[] = [];

    const result = await suite.driver.transaction(async () => {
      await PgTxUser.create({ Name: 'kept' });
      await suite.driver.afterCommit(() => {
        ran.push('afterCommit');
      });
      return 'the-value';
    });

    expect(result).to.equal('the-value');
    expect(ran).to.deep.equal(['afterCommit']);
    expect(await names()).to.deep.equal(['kept']);
  });
});
