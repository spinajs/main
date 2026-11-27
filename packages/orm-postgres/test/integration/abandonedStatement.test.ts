import { expect } from 'chai';
import 'mocha';
import pg from 'pg';

import { IPgSuite, openSuite } from './harness.js';

type QueryTimeout = { connectionParameters: { query_timeout?: number } };

describe('postgres integration - a statement abandoned by its client', function () {
  let suite: IPgSuite;

  before(async function () {
    // One connection: the client of the abandoned statement is the one the next statement would get.
    suite = await openSuite(this, { name: 'abandoned', pool: { Max: 1 } });
  });

  after(async () => {
    await suite?.close();
  });

  it('does not make the next statement wait for it', async () => {
    const pool = (suite.driver as unknown as { Pool: pg.Pool }).Pool;
    const [{ pid }] = await suite.raw<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
    pool.once('acquire', (client: pg.PoolClient) => {
      (client as unknown as QueryTimeout).connectionParameters.query_timeout = 500;
    });
    pool.once('release', (_err: Error, client: pg.PoolClient) => {
      (client as unknown as QueryTimeout).connectionParameters.query_timeout = undefined;
    });

    await suite.raw("SELECT 'sx22_abandoned', pg_sleep(3)").then(
      () => expect.fail('the client-side timeout did not fire'),
      () => undefined,
    );

    // Read while the next statement runs: queued behind the abandoned statement it would find that backend done.
    const [next] = await suite.raw<{ pid: number; abandoned: string | null }[]>(
      'SELECT pg_backend_pid() AS pid, (SELECT state FROM pg_stat_activity WHERE pid = ? AND query LIKE ?) AS abandoned',
      [pid, '%sx22_abandoned%'],
    );
    expect(next.pid, 'the next statement runs on another backend').to.not.equal(pid);
    expect(next.abandoned, 'the abandoned statement is still running on the server').to.equal('active');
  });
});
