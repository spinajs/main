/**
 * A transaction InnoDB rolled back after a deadlock, against a live MySQL (the integration server, ORM_TEST_MYSQL_*), in
 * a database of its own per run. Without a server it fails, as the package's other live files do.
 */
import { DI } from '@spinajs/di';
import '@spinajs/log';
import { QueryContext, TransactionAborted } from '@spinajs/orm';
import * as chai from 'chai';
import 'mocha';
import { randomBytes } from 'node:crypto';
import { createConnection, type Connection } from 'mysql2/promise';

import { MySqlOrmDriver } from '../../src/index.js';

const expect = chai.expect;

const SERVER = {
  host: process.env.ORM_TEST_MYSQL_HOST ?? '127.0.0.1',
  port: Number(process.env.ORM_TEST_MYSQL_PORT ?? 13306),
  user: process.env.ORM_TEST_MYSQL_USER ?? 'root',
  password: process.env.ORM_TEST_MYSQL_PASSWORD ?? 'root',
};
const DATABASE = `spinajs_sx18_${randomBytes(4).toString('hex')}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = (p: Promise<unknown>): Promise<unknown> => p.then((value) => value, (err: unknown) => err);
const OTHER_ROWS = Array.from({ length: 20 }, () => 'other');

function signal() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open: () => open(), opened };
}

/** Resolves once the server's connection `thread` waits for a row lock (performance_schema; `INNODB_TRX` is a cache that stays frozen while it is polled faster than every 100 ms). */
async function lockWaitOf(admin: Connection, thread: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [rows] = await admin.query('SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w JOIN performance_schema.threads t ON t.THREAD_ID = w.REQUESTING_THREAD_ID WHERE t.PROCESSLIST_ID = ?', [thread]);
    if (Number((rows as Array<{ n: unknown }>)[0]?.n) > 0) return;
    await sleep(50);
  }
  throw new Error(`connection ${thread} never waited for a row lock`);
}

describe('MySQL transaction rolled back by a deadlock (live server)', function () {
  this.timeout(60000);

  let driver: MySqlOrmDriver;
  let admin: Connection | undefined;

  const db = (): Connection => {
    if (admin === undefined) throw new Error('no admin connection');
    return admin;
  };
  const run = (sql: string, context = QueryContext.Update) => driver.executeOnDb(sql, [], context);
  const threadOf = async () => Number(((await run('SELECT CONNECTION_ID() AS id', QueryContext.Select)) as Array<{ id: unknown }>)[0].id);

  async function logged(): Promise<string[]> {
    const [log] = await db().query(`SELECT \`who\` FROM \`${DATABASE}\`.\`sx18_log\` ORDER BY \`who\``);
    return (log as Array<{ who: string }>).map((r) => r.who);
  }

  async function values(): Promise<number[][]> {
    const [rows] = await db().query(`SELECT \`id\`, \`v\` FROM \`${DATABASE}\`.\`sx18_row\` ORDER BY \`id\``);
    return (rows as Array<{ id: number; v: number }>).map((r) => [r.id, r.v]);
  }

  /** The heavier transaction of a deadlock: twenty rows make InnoDB roll back the other one, which changed fewer. */
  function survivor(victimThread: () => number, victimHolds: Promise<void>, otherHolds: () => void, start: () => Promise<void> = () => Promise.resolve()) {
    return driver.transaction(async () => {
      await start();
      await run(`INSERT INTO \`sx18_log\` (\`who\`) VALUES ${OTHER_ROWS.map(() => "('other')").join(', ')}`, QueryContext.Insert);
      await run('UPDATE `sx18_row` SET `v` = `v` + 1 WHERE `id` = 2');
      otherHolds();
      await victimHolds;
      await lockWaitOf(db(), victimThread());
      await run('UPDATE `sx18_row` SET `v` = `v` + 1 WHERE `id` = 1');
      return 'other committed';
    });
  }

  before(async () => {
    admin = await createConnection({ ...SERVER, connectTimeout: 3000 });
    const [detect] = await admin.query('SELECT @@innodb_deadlock_detect AS on_detect');
    if (Number((detect as Array<{ on_detect: unknown }>)[0]?.on_detect) !== 1) throw new Error('the server runs with innodb_deadlock_detect off; this test needs deadlock detection');
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${DATABASE}\``);
    await admin.query(`CREATE TABLE IF NOT EXISTS \`${DATABASE}\`.\`sx18_row\` (\`id\` INT PRIMARY KEY, \`v\` INT NOT NULL) ENGINE=InnoDB`);
    await admin.query(`CREATE TABLE IF NOT EXISTS \`${DATABASE}\`.\`sx18_log\` (\`who\` VARCHAR(32) NOT NULL) ENGINE=InnoDB`);
    driver = await DI.child().resolve(MySqlOrmDriver, [{ Name: 'mysql-server-rollback', Driver: 'orm-driver-mysql', Host: SERVER.host, Port: SERVER.port, User: SERVER.user, Password: SERVER.password, Database: DATABASE }]);
    await driver.connect();
  });

  beforeEach(async () => {
    await admin?.query(`DELETE FROM \`${DATABASE}\`.\`sx18_log\``);
    await admin?.query(`REPLACE INTO \`${DATABASE}\`.\`sx18_row\` (\`id\`, \`v\`) VALUES (1, 0), (2, 0)`);
  });

  after(async () => {
    try {
      await driver?.disconnect();
    } finally {
      await admin?.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
      await admin?.end();
    }
  });

  it('refuses the rest of the victim transaction, writes none of it and runs none of its afterCommit callbacks', async () => {
    const victimHolds = signal();
    const otherHolds = signal();
    const ran: string[] = [];
    let victimThread = 0;
    let deadlock: unknown;
    let later: unknown;

    const victim = settle(
      driver.transaction(async () => {
        await driver.afterCommit(() => {
          ran.push('victim');
        });
        victimThread = await threadOf();
        await run("INSERT INTO `sx18_log` (`who`) VALUES ('victim-before')", QueryContext.Insert);
        await run('UPDATE `sx18_row` SET `v` = `v` + 1 WHERE `id` = 1');
        victimHolds.open();
        await otherHolds.opened;
        deadlock = await settle(run('UPDATE `sx18_row` SET `v` = `v` + 1 WHERE `id` = 2'));
        // the application caught the deadlock and goes on
        later = await settle(run("INSERT INTO `sx18_log` (`who`) VALUES ('victim-after')", QueryContext.Insert));
      }),
    );
    const other = settle(
      survivor(() => victimThread, victimHolds.opened, otherHolds.open, () =>
        driver.afterCommit(() => {
          ran.push('other');
        }),
      ),
    );

    const [victimOutcome, otherOutcome] = await Promise.all([victim, other]);

    expect(deadlock).to.have.nested.property('inner.errno', 1213);
    expect(later).to.be.instanceOf(TransactionAborted);
    expect(victimOutcome).to.be.instanceOf(TransactionAborted);
    expect((victimOutcome as Error).message).to.include('was rolled back by MySQL');
    expect(victimOutcome).to.have.nested.property('inner.errno', 1213);
    expect(otherOutcome).to.equal('other committed');
    expect(ran).to.deep.equal(['other']);
    expect(await logged()).to.deep.equal(OTHER_ROWS);
    expect(await values()).to.deep.equal([
      [1, 1],
      [2, 1],
    ]);
  });

  it('hands a nested transaction the deadlock, not "SAVEPOINT sp_1 does not exist", and commits nothing of the outer one', async () => {
    const victimHolds = signal();
    const otherHolds = signal();
    let victimThread = 0;
    let nested: unknown;

    const victim = settle(
      driver.transaction(async () => {
        victimThread = await threadOf();
        await run("INSERT INTO `sx18_log` (`who`) VALUES ('victim-before')", QueryContext.Insert);
        await run('UPDATE `sx18_row` SET `v` = `v` + 1 WHERE `id` = 1');
        victimHolds.open();
        await otherHolds.opened;
        nested = await settle(driver.transaction(() => run('UPDATE `sx18_row` SET `v` = `v` + 1 WHERE `id` = 2')));
        await settle(run("INSERT INTO `sx18_log` (`who`) VALUES ('victim-after')", QueryContext.Insert));
      }),
    );
    const other = settle(survivor(() => victimThread, victimHolds.opened, otherHolds.open));
    const [victimOutcome] = await Promise.all([victim, other]);

    expect(nested).to.have.nested.property('inner.errno', 1213);
    expect(String((nested as Error).message)).to.not.include('does not exist');
    expect(victimOutcome).to.be.instanceOf(TransactionAborted);
    expect(victimOutcome).to.have.nested.property('inner.errno', 1213);
    expect(await logged()).to.deep.equal(OTHER_ROWS);
  });

  // Last in the file: it leaves innodb_lock_wait_timeout = 1 on a pooled connection of the driver.
  it('after a lock wait timeout commits the rest of the transaction only when the server keeps it (innodb_rollback_on_timeout)', async () => {
    const [setting] = await db().query('SELECT @@innodb_rollback_on_timeout AS on_timeout');
    const serverRollsBack = Number((setting as Array<{ on_timeout: unknown }>)[0]?.on_timeout) === 1;
    const holder = await createConnection({ ...SERVER, database: DATABASE });
    let timeout: unknown;
    let later: unknown;

    try {
      await holder.query('BEGIN');
      await holder.query('UPDATE `sx18_row` SET `v` = `v` + 10 WHERE `id` = 2');

      const outcome = await settle(
        driver.transaction(async () => {
          await run('SET SESSION innodb_lock_wait_timeout = 1', QueryContext.Schema);
          await run("INSERT INTO `sx18_log` (`who`) VALUES ('before')", QueryContext.Insert);
          await run('UPDATE `sx18_row` SET `v` = `v` + 1 WHERE `id` = 1');
          timeout = await settle(run('UPDATE `sx18_row` SET `v` = `v` + 1 WHERE `id` = 2'));
          later = await settle(run("INSERT INTO `sx18_log` (`who`) VALUES ('after')", QueryContext.Insert));
          return 'committed';
        }),
      );

      expect(timeout).to.have.nested.property('inner.errno', 1205);
      if (serverRollsBack) {
        expect(later).to.be.instanceOf(TransactionAborted);
        expect(outcome).to.be.instanceOf(TransactionAborted);
        expect(await logged()).to.deep.equal([]);
      } else {
        expect(outcome).to.equal('committed');
        expect(await logged()).to.deep.equal(['after', 'before']);
        expect(await values()).to.deep.equal([
          [1, 1],
          [2, 0],
        ]);
      }
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
  });
});
