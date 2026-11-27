import { expect } from 'chai';
import 'mocha';
import pg from 'pg';
import { OrmException } from '@spinajs/orm';

import { IPgSuite, openSuite } from './harness.js';

type QueryTimeout = { connectionParameters: { query_timeout?: number } };

const NO_ANSWER = 'got no answer from the server';

describe('postgres integration - a plain transaction whose statement timed out on the client', function () {
  let suite: IPgSuite;

  before(async function () {
    // One connection: the check after the transaction runs on the client the pool hands out next.
    suite = await openSuite(this, { name: 'timed_out_statement', pool: { Max: 1 } });
    await suite.raw('CREATE TABLE sx23b_rows (n int NOT NULL)');
  });

  beforeEach(() => suite.reset('sx23b_rows'));

  after(async () => {
    await suite?.close();
  });

  /** Runs `body` in a transaction and settles to its rejection (undefined when it resolved) and its backend pid. */
  async function inTransaction(body: (client: QueryTimeout) => Promise<unknown>): Promise<{ err: unknown; pid: number }> {
    const pool = (suite.driver as unknown as { Pool: pg.Pool }).Pool;
    const checkout = new Promise<QueryTimeout>((resolve) => pool.once('acquire', (client: pg.PoolClient) => resolve(client as unknown as QueryTimeout)));
    let pid = 0;
    const err = await suite.driver
      .transaction(async () => {
        const client = await checkout;
        const [row] = await suite.raw<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
        pid = row.pid;
        await suite.raw('INSERT INTO sx23b_rows (n) VALUES (1)');
        return body(client);
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    return { err, pid };
  }

  /** The insert times out on the client after 500 ms and goes on on the server for 1.5 s. */
  async function abandonInsert(client: QueryTimeout): Promise<unknown> {
    client.connectionParameters.query_timeout = 500;
    const err = await suite.raw('INSERT INTO sx23b_rows (n) SELECT 7 FROM pg_sleep(1.5)').then(
      () => undefined,
      (e: unknown) => e,
    );
    client.connectionParameters.query_timeout = undefined;
    expect(err, 'the insert was reported as failed').to.be.instanceOf(Error);
    return err;
  }

  async function expectNothingCommittedAndClientDestroyed(pid: number): Promise<void> {
    expect(await suite.raw<{ n: number }[]>('SELECT n FROM sx23b_rows ORDER BY n')).to.deep.equal([]);
    const [next] = await suite.raw<{ pid: number; own: boolean }[]>('SELECT pg_backend_pid() AS pid, now() = statement_timestamp() AS own');
    expect(next.pid, 'the refused transaction left on a destroyed client').to.not.equal(pid);
    expect(next.own, 'the next statement runs in a transaction of its own').to.equal(true);
    const open = await suite.external<{ pid: number }[]>("SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'");
    expect(open, 'no session of this database is left inside a transaction').to.deep.equal([]);
    expect(suite.driver.poolMetrics().InUse).to.equal(0);
  }

  function expectNoAnswerRefusal(err: unknown): void {
    expect(err).to.be.instanceOf(OrmException);
    expect((err as OrmException).message).to.include(NO_ANSWER);
  }

  it('commits nothing, although the callback caught the timeout and went on', async () => {
    const { err, pid } = await inTransaction(async (client) => {
      await abandonInsert(client);
      return 'the work';
    });

    expectNoAnswerRefusal(err);
    expect((err as OrmException).inner).to.be.instanceOf(Error).with.property('message', 'Query read timeout');
    await expectNothingCommittedAndClientDestroyed(pid);
  });

  it("rejects with the callback's own error when the callback throws after the timeout", async () => {
    const failed = new Error('the work failed');
    const { err, pid } = await inTransaction(async (client) => {
      await abandonInsert(client);
      throw failed;
    });

    expect(err).to.equal(failed);
    await expectNothingCommittedAndClientDestroyed(pid);
  });

  it('runs a later statement behind the abandoned one and still refuses the commit', async () => {
    let seen: { n: number }[] = [];
    const { err, pid } = await inTransaction(async (client) => {
      await abandonInsert(client);
      await suite.raw('INSERT INTO sx23b_rows (n) VALUES (3)');
      seen = await suite.raw<{ n: number }[]>('SELECT n FROM sx23b_rows ORDER BY n');
    });

    // The later statements are not refused: they wait on the client until the abandoned insert ends, and see its row.
    expect(seen).to.deep.equal([{ n: 1 }, { n: 3 }, { n: 7 }]);
    await expectNothingCommittedAndClientDestroyed(pid);
    expectNoAnswerRefusal(err);
  });

  it('refuses the commit after a nested transaction opened past the timeout completed', async () => {
    const { err, pid } = await inTransaction(async (client) => {
      await abandonInsert(client);
      await suite.driver.transaction(() => suite.raw('INSERT INTO sx23b_rows (n) VALUES (3)'));
    });

    await expectNothingCommittedAndClientDestroyed(pid);
    expectNoAnswerRefusal(err);
  });

  it('refuses the whole outer transaction when the timeout happened inside a nested one that caught it', async () => {
    const { err, pid } = await inTransaction(async (client) => {
      await suite.driver.transaction(async () => {
        await abandonInsert(client);
      });
      await suite.raw('INSERT INTO sx23b_rows (n) VALUES (3)');
    });

    await expectNothingCommittedAndClientDestroyed(pid);
    expectNoAnswerRefusal(err);
  });

  it('does not mark a server-side statement_timeout, which PostgreSQL answers and aborts the transaction for itself', async () => {
    let cancelled: unknown;
    const { err, pid } = await inTransaction(async () => {
      await suite.raw("SET LOCAL statement_timeout = '200ms'");
      cancelled = await suite.raw('INSERT INTO sx23b_rows (n) SELECT 7 FROM pg_sleep(1.5)').then(
        () => undefined,
        (e: unknown) => e,
      );
      return 'the work';
    });

    expect(cancelled, 'the server cancelled the insert').to.be.instanceOf(OrmException).with.nested.property('inner.code', '57014');
    // Without SX-16 the aborted COMMIT resolves silently; with it the caller gets SX-16's refusal: never this one.
    expect(err === undefined ? '' : String((err as Error).message)).to.not.include(NO_ANSWER);
    expect(await suite.raw<{ n: number }[]>('SELECT n FROM sx23b_rows ORDER BY n')).to.deep.equal([]);
    const [next] = await suite.raw<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
    expect(next.pid, 'the client went back to the pool').to.equal(pid);
  });
});
