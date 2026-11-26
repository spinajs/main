import { expect } from 'chai';
import 'mocha';
import pg from 'pg';

import { IPgSuite, openSuite, sqlState } from './harness.js';

type Query = (text: string, ...rest: unknown[]) => Promise<pg.QueryResult>;

describe('postgres integration - a transaction that fails to open', function () {
  let suite: IPgSuite;

  before(async function () {
    // One connection: a pooled client of the failed transaction is the one the next statement gets.
    suite = await openSuite(this, { name: 'tx_open', pool: { Max: 1 } });
  });

  after(async () => {
    await suite?.close();
  });

  /**
   * Makes the server refuse the next `SET TRANSACTION ISOLATION LEVEL`, as a hot standby refuses
   * SERIALIZABLE: one query runs in the transaction before it, so PostgreSQL answers 25001 and the
   * session is left inside an aborted transaction. Resolves to that session's backend pid.
   */
  const refuseNextIsolationLevel = () =>
    new Promise<number>((resolve) => {
      const pool = (suite.driver as unknown as { Pool: pg.Pool }).Pool;
      pool.once('acquire', (client: pg.PoolClient) => {
        const query = client.query.bind(client) as unknown as Query;
        let armed = true;
        const refusing: Query = async (text, ...rest) => {
          if (armed && text.startsWith('SET TRANSACTION ISOLATION LEVEL')) {
            armed = false;
            const { rows } = await query('SELECT pg_backend_pid() AS pid');
            resolve((rows[0] as { pid: number }).pid);
          }
          return query(text, ...rest);
        };
        Object.assign(client, { query: refusing });
      });
    });

  it('does not hand the aborted session to the next statement', async () => {
    const failedPid = refuseNextIsolationLevel();

    const err = await suite.driver.transaction(async () => 1, { isolation: 'SERIALIZABLE' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(sqlState(err)).to.equal('25001');

    const [next] = await suite.raw<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
    expect(next.pid).to.not.equal(await failedPid);
    expect(suite.driver.poolMetrics().InUse).to.equal(0);
  });
});
