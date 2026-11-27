import { expect } from 'chai';
import 'mocha';
import pg from 'pg';
import { OrmException } from '@spinajs/orm';

import { IPgSuite, openSuite } from './harness.js';

type QueryTimeout = { connectionParameters: { query_timeout?: number } };

describe('postgres integration - a nested transaction whose ROLLBACK TO SAVEPOINT never reached the server', function () {
  let suite: IPgSuite;

  before(async function () {
    // One connection: the client the next statement gets shows whether the refused transaction's client was pooled.
    suite = await openSuite(this, { name: 'lost_savepoint', pool: { Max: 1 } });
    await suite.raw('CREATE TABLE sx23_rows (n int NOT NULL)');
  });

  after(async () => {
    await suite?.close();
  });

  it('commits nothing, although the outer body caught the nested rejection and went on', async () => {
    const pool = (suite.driver as unknown as { Pool: pg.Pool }).Pool;
    const checkout = new Promise<QueryTimeout>((resolve) => pool.once('acquire', (client: pg.PoolClient) => resolve(client as unknown as QueryTimeout)));
    let failedPid = 0;
    let nested: unknown;

    const err = await suite.driver
      .transaction(async () => {
        const client = await checkout;
        const [row] = await suite.raw<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
        failedPid = row.pid;
        await suite.raw('INSERT INTO sx23_rows (n) VALUES (1)');
        await suite.driver
          .transaction(async () => {
            await suite.raw('INSERT INTO sx23_rows (n) VALUES (2)');
            // The sleep times out on the client and goes on on the server; the ROLLBACK TO queued behind it times out unsent.
            client.connectionParameters.query_timeout = 500;
            await suite.raw('SELECT pg_sleep(3)');
          })
          .catch((e: unknown) => {
            nested = e;
          });
        client.connectionParameters.query_timeout = undefined;
        await suite.raw('INSERT INTO sx23_rows (n) VALUES (3)');
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(nested, 'the nested call rejected').to.be.instanceOf(Error);
    expect(err).to.be.instanceOf(OrmException).with.property('inner', nested);
    expect(await suite.raw<{ n: number }[]>('SELECT n FROM sx23_rows ORDER BY n')).to.deep.equal([]);

    const [next] = await suite.raw<{ pid: number; own: boolean }[]>('SELECT pg_backend_pid() AS pid, now() = statement_timestamp() AS own');
    expect(next.pid, 'the refused transaction left on a destroyed client').to.not.equal(failedPid);
    expect(next.own, 'the next statement runs in a transaction of its own').to.equal(true);
    const open = await suite.external<{ pid: number }[]>("SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'");
    expect(open, 'no session of this database is left inside a transaction').to.deep.equal([]);
    expect(suite.driver.poolMetrics().InUse).to.equal(0);
  });
});
