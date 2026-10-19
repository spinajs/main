import 'mocha';
import { expect } from 'chai';
import pg from 'pg';
import { InvalidOperation } from '@spinajs/exceptions';
import { QueryContext } from '@spinajs/orm';
import { bootPostgres, PG_SERVER, PgTestDb, requirePostgres } from './support.js';

describe('postgres lockTable (integration)', function () {
  this.timeout(60000);

  let pgdb: PgTestDb | undefined;

  before(async function () {
    await requirePostgres(this);
    pgdb = await bootPostgres('lock_table');
    await pgdb.driver.schema().createTable('pg_lock_t', (table) => {
      table.int('Id').primaryKey();
    });
  });

  after(async () => {
    await pgdb?.dispose();
  });

  /** Another session that gives up on a lock after 300 ms instead of waiting. */
  async function otherSession(): Promise<pg.Client> {
    const client = new pg.Client({ host: PG_SERVER.Host, port: PG_SERVER.Port, user: PG_SERVER.User, password: PG_SERVER.Password, database: pgdb!.name });
    await client.connect();
    await client.query(`SET lock_timeout = '300ms'`);
    return client;
  }

  it('holds a SHARE lock until the transaction ends: other sessions read but cannot write', async () => {
    const other = await otherSession();

    try {
      await pgdb!.driver.transaction(async () => {
        await pgdb!.driver.schema().lockTable('pg_lock_t');

        const held = (await pgdb!.driver.executeOnDb(`SELECT mode FROM pg_locks WHERE relation = 'pg_lock_t'::regclass AND pid = pg_backend_pid() AND granted`, [], QueryContext.Select)) as { mode: string }[];
        expect(held.map((l) => l.mode)).to.include('ShareLock');

        await other.query('SELECT COUNT(*) FROM pg_lock_t');
        const blocked = await other.query('INSERT INTO pg_lock_t ("Id") VALUES (1)').then(
          () => undefined,
          (e: { code?: string }) => e,
        );
        // lock_not_available: the insert waited for the lock and gave up
        expect(blocked?.code).to.eq('55P03');
      });

      await other.query('INSERT INTO pg_lock_t ("Id") VALUES (2)');
    } finally {
      await other.end();
    }
  });

  it('refuses to run outside a transaction', async () => {
    const err = await pgdb!.driver
      .schema()
      .lockTable('pg_lock_t')
      .execute()
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(err).to.be.instanceOf(InvalidOperation);
  });
});
