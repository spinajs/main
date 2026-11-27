import { expect } from 'chai';
import 'mocha';
import pg from 'pg';

import { IPgSuite, openSuite } from './harness.js';

type QueryTimeout = { connectionParameters: { query_timeout?: number } };

describe('postgres integration - a transaction whose ROLLBACK fails', function () {
  let suite: IPgSuite;

  before(async function () {
    // One connection: a pooled client of the failed transaction is the one the next statement gets.
    suite = await openSuite(this, { name: 'tx_rollback', pool: { Max: 1 } });
  });

  after(async () => {
    await suite?.close();
  });

  /** The client the next transaction checks out; a `query_timeout` set on it ends when it is released. */
  const nextCheckout = () =>
    new Promise<QueryTimeout>((resolve) => {
      const pool = (suite.driver as unknown as { Pool: pg.Pool }).Pool;
      pool.once('acquire', (client: pg.PoolClient) => resolve(client as unknown as QueryTimeout));
      pool.once('release', (_err: Error, client: pg.PoolClient) => {
        (client as unknown as QueryTimeout).connectionParameters.query_timeout = undefined;
      });
    });

  it('does not hand the session left inside the transaction to the next statement', async () => {
    const checkout = nextCheckout();
    let failedPid = 0;

    const err = await suite.driver
      .transaction(async () => {
        const client = await checkout;
        const [row] = await suite.raw<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
        failedPid = row.pid;
        await suite.raw("SET LOCAL application_name = 'sx02_left_in_transaction'");
        // pg's client-side timeout rejects the sleep while the server still runs it; the ROLLBACK queued
        // behind it times out too and is never sent, so the live session stays inside the transaction.
        client.connectionParameters.query_timeout = 500;
        await suite.raw('SELECT pg_sleep(5)').catch(() => undefined);
        throw new Error('the work failed');
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).to.be.instanceOf(Error).with.property('message', 'the work failed');

    const [next] = await suite.raw<{ pid: number; app: string; own: boolean }[]>(
      "SELECT pg_backend_pid() AS pid, current_setting('application_name') AS app, now() = statement_timestamp() AS own",
    );
    expect(next.app).to.not.equal('sx02_left_in_transaction');
    expect(next.own, 'the next statement runs in a transaction of its own').to.equal(true);
    expect(next.pid).to.not.equal(failedPid);
    expect(suite.driver.poolMetrics().InUse).to.equal(0);
  });
});
