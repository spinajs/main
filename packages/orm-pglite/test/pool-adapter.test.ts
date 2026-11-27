import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { PGlite } from '@electric-sql/pglite';

import { PglitePool, pgCompatibleParsers, type PglitePoolClient, type PgliteQueryResult } from '../src/pool-adapter.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

type Query = (text: string, params?: unknown[]) => Promise<PgliteQueryResult>;

describe('PGlite pool adapter', function () {
  let pool: PglitePool;

  before(async () => {
    const db = await PGlite.create();
    await db.exec(`SET TimeZone TO 'UTC'`);
    pool = new PglitePool(db, await pgCompatibleParsers(db), 200);
  });

  after(async () => {
    await pool.end();
  });

  async function onClient<T>(fn: (query: Query) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      return await fn(async (text, params) => (await client.query(text, params)) as PgliteQueryResult);
    } finally {
      client.release();
    }
  }

  it('parses every type the way the postgres driver pool parses it', async () => {
    const [row] = (await onClient(async (query) => {
      const result = await query(
        `SELECT 9007199254740993::int8 AS big, count(*) AS n, 1.50::numeric(10,2) AS dec, '2026-10-19'::date AS day,
                '2026-10-19 12:00:00.123'::timestamp AS ts, '2026-10-19 14:00:00+02'::timestamptz AS tstz,
                '1 day 02:00:00'::interval AS iv, '\\x0102'::bytea AS bin, ARRAY[1,2]::int8[] AS bigs, '{"a":1}'::jsonb AS doc
         FROM (VALUES (1)) AS v(x)`,
      );
      return result.rows;
    })) as Array<Record<string, unknown>>;

    expect(row.big).to.equal('9007199254740993');
    expect(row.n).to.equal('1');
    expect(row.dec).to.equal('1.50');
    expect((row.day as Date).toISOString()).to.equal('2026-10-19T00:00:00.000Z');
    expect((row.ts as Date).toISOString()).to.equal('2026-10-19T12:00:00.123Z');
    expect((row.tstz as Date).toISOString()).to.equal('2026-10-19T12:00:00.000Z');
    expect(row.iv).to.include({ days: 1, hours: 2 });
    expect(Buffer.isBuffer(row.bin) && row.bin.toString('hex')).to.equal('0102');
    expect(row.bigs).to.deep.equal(['1', '2']);
    expect(row.doc).to.deep.equal({ a: 1 });
  });

  it('serializes parameters the way pg does', async () => {
    const rows = await onClient(async (query) => {
      await query('CREATE TABLE adapter_params (t text, j jsonb, ia int4[], b bool)');
      await query('INSERT INTO adapter_params (t, j, ia, b) VALUES ($1, $2, $3, $4)', [{ a: 1 }, { b: [1, 2] }, [1, 2], 1]);
      return (await query('SELECT t, j::text AS j, ia::text AS ia, b FROM adapter_params')).rows;
    });

    expect(rows).to.deep.equal([{ t: '{"a":1}', j: '{"b": [1, 2]}', ia: '{1,2}', b: true }]);
  });

  it('runs several statements without values and reports rowCount per statement', async () => {
    const { several, inserted, updated } = await onClient(async (query) => {
      const both = (await query('SELECT 1 AS a; SELECT 2 AS b')) as unknown as PgliteQueryResult[];
      await query('CREATE TABLE adapter_counts (id int)');
      const ins = await query('INSERT INTO adapter_counts VALUES ($1), ($2) RETURNING id', [1, 2]);
      const upd = await query('UPDATE adapter_counts SET id = id + $1', [10]);
      return { several: both, inserted: ins, updated: upd };
    });

    expect(several.map((r) => r.rows)).to.deep.equal([[{ a: 1 }], [{ b: 2 }]]);
    expect(several.map((r) => r.command)).to.deep.equal(['SELECT', 'SELECT']);
    expect(inserted.command).to.equal('INSERT');
    expect(inserted.rowCount).to.equal(2);
    expect(inserted.rows).to.deep.equal([{ id: 1 }, { id: 2 }]);
    expect(updated.rowCount).to.equal(2);
  });

  it('counts the rows of each statement of one run on their own', async () => {
    const results = await onClient(async (query) => {
      await query('CREATE TABLE adapter_run (id int)');
      return (await query('INSERT INTO adapter_run VALUES (1), (2); UPDATE adapter_run SET id = id + 1; DELETE FROM adapter_run WHERE id = 3')) as unknown as PgliteQueryResult[];
    });

    expect(results.map((r) => [r.command, r.rowCount])).to.deep.equal([
      ['INSERT', 2],
      ['UPDATE', 2],
      ['DELETE', 1],
    ]);
  });

  it('hands the session out one client at a time, in request order', async () => {
    const first = await pool.connect();
    const order: number[] = [];
    const second = pool.connect().then((c) => {
      order.push(2);
      return c;
    });
    const third = pool.connect().then((c) => {
      order.push(3);
      return c;
    });

    expect(pool.waitingCount).to.equal(2);
    expect(pool.idleCount).to.equal(0);

    first.release();
    (await second).release();
    (await third).release();

    expect(order).to.deep.equal([2, 3]);
    expect(pool.idleCount).to.equal(1);
    expect(pool.waitingCount).to.equal(0);
  });

  it('fails a waiting connect after the acquire timeout', async () => {
    const held = await pool.connect();
    try {
      await expect(pool.connect()).to.be.rejectedWith(/timeout exceeded when trying to connect/);
      expect(pool.waitingCount).to.equal(0);
    } finally {
      held.release();
    }
  });

  it('refuses a second release of one client', async () => {
    const client = await pool.connect();
    client.release();
    expect(() => client.release()).to.throw(/already been released/);
  });

  it('rejects waiters and closes PGlite on end()', async () => {
    const db = await PGlite.create();
    const own = new PglitePool(db, {}, 5000);
    await own.connect();
    const waiting = own.connect();

    await own.end();

    await expect(waiting).to.be.rejectedWith(/after calling end on the pool/);
    await expect(own.connect()).to.be.rejectedWith(/after calling end on the pool/);
    expect(db.closed).to.equal(true);
  });
});

describe('PGlite pool adapter: a client released with an error', function () {
  const opened: PglitePool[] = [];

  /** A session of its own per test, recording what the adapter sends; `hold` delays its ROLLBACK, `refuse` fails it. */
  async function session(stage: { hold?: Promise<void>; refuse?: boolean } = {}) {
    const db = await PGlite.create();
    const events: string[] = [];
    const exec = db.exec.bind(db);
    db.exec = async (sql, options) => {
      events.push(sql);
      if (sql !== 'ROLLBACK') {
        return exec(sql, options);
      }

      await stage.hold;
      if (stage.refuse) {
        throw new Error('the session is broken');
      }
      const results = await exec(sql, options);
      events.push('rolled back');
      return results;
    };

    const pool = new PglitePool(db, await pgCompatibleParsers(db), 2000);
    opened.push(pool);
    return { pool, events };
  }

  // after a query PostgreSQL refuses SET TRANSACTION (25001) and leaves the transaction aborted
  async function abort(client: PglitePoolClient): Promise<void> {
    await client.query('BEGIN');
    await client.query('SELECT 1');
    await expect(client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')).to.be.rejectedWith(/before any query/);
  }

  const ok = async (client: PglitePoolClient, n: number) => ((await client.query(`SELECT ${n} AS ok`)) as PgliteQueryResult).rows;

  afterEach(async () => {
    for (const pool of opened.splice(0)) {
      await pool.end();
    }
  });

  it('rolls the session back before the next lease, which then runs outside any transaction', async () => {
    const { pool } = await session();
    const failed = await pool.connect();
    await abort(failed);

    const next = pool.connect();
    failed.release(true);
    const client = await next;
    try {
      expect(await ok(client, 1)).to.deep.equal([{ ok: 1 }]);
    } finally {
      client.release();
    }
  });

  it('rolls the session back before the next lease when the client is released with an Error', async () => {
    const { pool, events } = await session();
    const failed = await pool.connect();
    await abort(failed);

    failed.release(new Error('the transaction failed'));
    const client = await pool.connect();
    try {
      expect(await ok(client, 1)).to.deep.equal([{ ok: 1 }]);
    } finally {
      client.release();
    }
    expect(events.filter((e) => e === 'ROLLBACK')).to.have.length(1);
  });

  it('sends no ROLLBACK on release() and release(false)', async () => {
    const { pool, events } = await session();

    const plain = await pool.connect();
    await plain.query('SELECT 1');
    plain.release();
    const kept = await pool.connect();
    await kept.query('SELECT 2');
    kept.release(false);
    (await pool.connect()).release();

    expect(events).to.deep.equal(['SELECT 1', 'SELECT 2']);
  });

  it('refuses a second release of a client released with an error and rolls back once', async () => {
    const { pool, events } = await session();
    const failed = await pool.connect();
    await abort(failed);

    failed.release(true);
    expect(() => failed.release(true)).to.throw(/already been released/);
    expect(() => failed.release()).to.throw(/already been released/);

    const client = await pool.connect();
    try {
      expect(await ok(client, 1)).to.deep.equal([{ ok: 1 }]);
    } finally {
      client.release();
    }
    expect(events.filter((e) => e === 'ROLLBACK')).to.have.length(1);
  });

  it('keeps the lease until the rollback ran, then hands it to the waiters in request order', async () => {
    let open: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { pool, events } = await session({ hold });
    const failed = await pool.connect();
    await abort(failed);

    const granted = (name: string) => (client: PglitePoolClient) => {
      events.push(`granted ${name}`);
      return client;
    };
    const first = pool.connect().then(granted('first'));
    failed.release(true);
    const second = pool.connect().then(granted('second'));
    expect(pool.idleCount).to.equal(0);
    expect(pool.waitingCount).to.equal(2);

    open();
    const a = await first;
    expect(await ok(a, 1)).to.deep.equal([{ ok: 1 }]);
    a.release();
    const b = await second;
    expect(await ok(b, 2)).to.deep.equal([{ ok: 2 }]);
    b.release();

    expect(events.slice(3)).to.deep.equal(['ROLLBACK', 'rolled back', 'granted first', 'SELECT 1 AS ok', 'granted second', 'SELECT 2 AS ok']);
  });

  it('ends the pool instead of handing out a session whose ROLLBACK failed', async () => {
    const { pool } = await session({ refuse: true });
    const failed = await pool.connect();
    await abort(failed);

    const waiting = pool.connect();
    failed.release(true);

    await expect(waiting).to.be.rejectedWith(/failed to roll back/);
    await expect(pool.connect()).to.be.rejectedWith(/failed to roll back/);
  });
});
