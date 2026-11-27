import { expect } from 'chai';
import 'mocha';
import pg from 'pg';
import sinon from 'sinon';

import { pgEscapeIdentifier } from '../../src/index.js';
import { IPgSuite, PG, openSuite, sqlState } from './harness.js';

const APPLICATION = `sx22b_${process.pid}`;
const POLLS = 40;

const fail = () => expect.fail('the client-side timeout did not fire');
const ignore = () => undefined;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('postgres integration - an abandoned statement is cancelled on the server', function () {
  let suite: IPgSuite;
  // its own client: one built from pg.defaults would take the short query_timeout too
  let probe: pg.Client;
  const saved = { query_timeout: pg.defaults.query_timeout, application_name: pg.defaults.application_name };

  /** Backends other than the probe's own that `sql` finds, polled until `done` or the budget runs out. */
  const pollBackends = async (sql: string, params: unknown[], done: (rows: number) => boolean): Promise<number> => {
    let rows = -1;
    for (let poll = 0; poll < POLLS && !done(rows); poll++) {
      if (poll > 0) {
        await pause(100);
      }
      const { rows: [{ n }] } = await probe.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND ${sql}`, params);
      rows = n;
    }
    return rows;
  };
  const running = (marker: string) => pollBackends("state = 'active' AND query LIKE $1", [`%${marker}%`], (n) => n === 0);

  before(async function () {
    // One connection: every abandoned statement past the first would otherwise run beside the pool's replacement.
    suite = await openSuite(this, { name: 'cancel', pool: { Max: 1 } });
    await suite.raw('CREATE TABLE sx22b_rows (n int)');
    probe = new pg.Client({ host: PG.Host, port: PG.Port, user: PG.User, password: PG.Password, database: PG.Database, query_timeout: 30000, application_name: 'sx22b_probe' });
    await probe.connect();
    // The clients the pool opens from here on take these; the reconnect drops the one it has.
    pg.defaults.query_timeout = 500;
    pg.defaults.application_name = APPLICATION;
    await suite.driver.connect();
  });

  afterEach(async () => {
    // a failed run leaves its sleeps behind, and they would hold the schema's DROP for 30 s
    await probe?.query("SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND query LIKE '%sx22b' || '_%'");
  });

  after(async () => {
    pg.defaults.query_timeout = saved.query_timeout;
    pg.defaults.application_name = saved.application_name;
    await probe?.end();
    await suite?.close();
  });

  it('stops the abandoned statement on its backend, and its write does not commit', async () => {
    await suite.raw("INSERT INTO sx22b_rows SELECT 1 FROM pg_sleep(30) WHERE 'sx22b_write' <> ''").then(fail, ignore);

    expect(await running('sx22b_write'), 'backends still running the abandoned write').to.equal(0);
    const { rows: [{ n }] } = await probe.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${pgEscapeIdentifier(suite.schema)}.sx22b_rows`);
    expect(n, 'rows the abandoned write committed').to.equal(0);
  });

  it('leaves no backend beside the pool after repeated timeouts', async () => {
    for (let i = 0; i < 5; i++) {
      await suite.raw("SELECT 'sx22b_many', pg_sleep(30)").then(fail, ignore);
    }

    const backends = await pollBackends('application_name = $1', [APPLICATION], (n) => n === suite.driver.poolMetrics().Size);
    expect(backends, 'server backends of this pool').to.equal(suite.driver.poolMetrics().Size);
  });

  it('cancels nothing after a result or a server-side statement_timeout', async () => {
    const cancel = sinon.spy(suite.driver as unknown as { cancelAbandoned(client: pg.PoolClient): unknown }, 'cancelAbandoned');
    try {
      const [{ pid }] = await suite.raw<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
      await suite.raw("SET statement_timeout = '100ms'");
      const refused: unknown = await suite.raw("SELECT 'sx22b_server', pg_sleep(2)").then(fail, (e: unknown) => e);
      expect(sqlState(refused)).to.equal('57014');
      await suite.raw('RESET statement_timeout');

      const [after] = await suite.raw<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
      expect(after.pid, 'the session that answered stays pooled').to.equal(pid);
      expect(cancel.callCount).to.equal(0);
    } finally {
      cancel.restore();
    }
  });
});
