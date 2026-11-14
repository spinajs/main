import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { PGlite } from '@electric-sql/pglite';

import { PglitePool, pgCompatibleParsers, type PgliteQueryResult } from '../src/pool-adapter.js';

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
