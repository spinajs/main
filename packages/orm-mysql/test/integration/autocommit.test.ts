/**
 * A MySQL transaction runs with autocommit off, and every way it ends hands the pool a connection back at autocommit 1 or
 * destroys it. Live server (ORM_TEST_MYSQL_*), a database of its own per run, a pool of ONE connection: the checkout
 * after a case is provably the connection the case used, unless the case destroyed it.
 */
import { DI } from '@spinajs/di';
import '@spinajs/log';
import { QueryContext, TransactionAborted } from '@spinajs/orm';
import * as chai from 'chai';
import 'mocha';
import { randomBytes } from 'node:crypto';
import { createConnection, type Connection } from 'mysql2/promise';
import type { PoolConnection, QueryError } from 'mysql2';

import { IMySqlTransactionContext, MySqlOrmDriver } from '../../src/index.js';

const expect = chai.expect;

const SERVER = {
  host: process.env.ORM_TEST_MYSQL_HOST ?? '127.0.0.1',
  port: Number(process.env.ORM_TEST_MYSQL_PORT ?? 13306),
  user: process.env.ORM_TEST_MYSQL_USER ?? 'root',
  password: process.env.ORM_TEST_MYSQL_PASSWORD ?? 'root',
};
const DATABASE = `v4_sx_18c_${randomBytes(4).toString('hex')}`;
const OTHER_ROWS = Array.from({ length: 20 }, () => 'other');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = (p: Promise<unknown>): Promise<unknown> => p.then((value) => value, (err: unknown) => err);

function column(rows: unknown, name: string): unknown[] {
  if (!Array.isArray(rows)) throw new Error('expected rows');
  return rows.map((row: unknown) => {
    const value: unknown = typeof row === 'object' && row !== null ? Reflect.get(row, name) : undefined;
    return value;
  });
}

function signal() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open: () => open(), opened };
}

/**
 * The ways a test makes a step fail on a live connection: the step is not sent, the session stays as it was. `replies`
 * fails mysql2's own `commit()` and `rollback()` under the driver's `_commit` and `_rollback`, so the driver's handling
 * of their answer is what runs.
 */
type Fault = 'commit' | 'rollback' | 'restore' | 'replies' | undefined;

const refuse = (cb?: (err: QueryError | null) => void) => cb?.(Object.assign(new Error('injected failure, the statement was not sent'), { code: 'INJECTED', fatal: false }));

class FaultyDriver extends MySqlOrmDriver {
  public fault: Fault;

  protected _commit(ctx: IMySqlTransactionContext): Promise<void> {
    if (this.fault === 'replies') this.refuseEnding(ctx);
    return this.fault === 'commit' ? Promise.reject(new Error('injected COMMIT failure')) : super._commit(ctx);
  }

  protected _rollback(ctx: IMySqlTransactionContext): Promise<void> {
    if (this.fault === 'replies') this.refuseEnding(ctx);
    return this.fault === 'rollback' ? Promise.reject(new Error('injected ROLLBACK failure')) : super._rollback(ctx);
  }

  private refuseEnding(ctx: IMySqlTransactionContext): void {
    ctx.connection.commit = refuse;
    ctx.connection.rollback = refuse;
  }

  protected restoreAutocommit(connection: PoolConnection): Promise<void> {
    return this.fault === 'restore' ? Promise.reject(new Error('injected SET autocommit = 1 failure')) : super.restoreAutocommit(connection);
  }
}

interface Session {
  id: number;
  autocommit: number;
}

describe('MySQL transaction autocommit (live server, pool of one)', function () {
  this.timeout(60000);

  let driver: FaultyDriver;
  let admin: Connection | undefined;

  const db = (): Connection => {
    if (admin === undefined) throw new Error('no admin connection');
    return admin;
  };
  const run = (sql: string, context = QueryContext.Insert) => driver.executeOnDb(sql, [], context);

  async function session(): Promise<Session> {
    const rows: unknown = await run('SELECT CONNECTION_ID() AS id, @@autocommit AS autocommit', QueryContext.Select);
    return { id: Number(column(rows, 'id')[0]), autocommit: Number(column(rows, 'autocommit')[0]) };
  }

  async function logged(): Promise<unknown[]> {
    const [rows] = await db().query(`SELECT \`who\` FROM \`${DATABASE}\`.\`log\` ORDER BY \`who\``);
    return column(rows, 'who');
  }

  async function onServer(thread: number): Promise<boolean> {
    // the server drops a closed client's thread a moment after the socket closes
    for (let i = 0; i < 40; i++) {
      const [rows] = await db().query('SELECT COUNT(*) AS n FROM performance_schema.threads WHERE PROCESSLIST_ID = ?', [thread]);
      if (Number(column(rows, 'n')[0]) === 0) return false;
      await sleep(50);
    }
    return true;
  }

  async function lockWaitOf(thread: number): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const [rows] = await db().query('SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w JOIN performance_schema.threads t ON t.THREAD_ID = w.REQUESTING_THREAD_ID WHERE t.PROCESSLIST_ID = ?', [thread]);
      if (Number(column(rows, 'n')[0]) > 0) return;
      await sleep(50);
    }
    throw new Error(`connection ${thread} never waited for a row lock`);
  }

  /** The next checkout is at autocommit 1, the same connection unless `destroyed`, and its plain write is committed. */
  async function expectClean(inside: Session, destroyed: boolean): Promise<void> {
    expect(inside.autocommit, 'autocommit inside the transaction').to.equal(0);
    const next = await session();
    expect(next.autocommit, 'autocommit of the next checkout').to.equal(1);
    if (destroyed) {
      expect(next.id, 'a new connection').to.not.equal(inside.id);
      expect(await onServer(inside.id), 'the old connection is closed').to.equal(false);
    } else {
      expect(next.id, 'the same connection').to.equal(inside.id);
    }

    await run("INSERT INTO `plain` (`tag`) VALUES ('after')");
    const [rows] = await db().query(`SELECT COUNT(*) AS n FROM \`${DATABASE}\`.\`plain\``);
    expect(Number(column(rows, 'n')[0]), 'a plain write after the transaction, seen by another connection').to.equal(1);
  }

  before(async () => {
    admin = await createConnection({ ...SERVER, connectTimeout: 3000 });
    await admin.query(`CREATE DATABASE \`${DATABASE}\``);
    await admin.query(`CREATE TABLE \`${DATABASE}\`.\`row\` (\`id\` INT PRIMARY KEY, \`v\` INT NOT NULL) ENGINE=InnoDB`);
    await admin.query(`CREATE TABLE \`${DATABASE}\`.\`log\` (\`who\` VARCHAR(32) NOT NULL) ENGINE=InnoDB`);
    await admin.query(`CREATE TABLE \`${DATABASE}\`.\`plain\` (\`tag\` VARCHAR(32) NOT NULL) ENGINE=InnoDB`);
  });

  // A driver per test: a connection one case leaves dirty cannot leak into the next case.
  beforeEach(async () => {
    await db().query(`DELETE FROM \`${DATABASE}\`.\`log\``);
    await db().query(`DELETE FROM \`${DATABASE}\`.\`plain\``);
    await db().query(`REPLACE INTO \`${DATABASE}\`.\`row\` (\`id\`, \`v\`) VALUES (1, 0), (2, 0)`);
    driver = await DI.child().resolve(FaultyDriver, [{ Name: 'mysql-autocommit', Driver: 'orm-driver-mysql', Host: SERVER.host, Port: SERVER.port, User: SERVER.user, Password: SERVER.password, Database: DATABASE, Pool: { Max: 1 } }]);
    await driver.connect();
  });

  afterEach(async () => {
    await driver?.disconnect();
  });

  after(async () => {
    try {
      await admin?.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
    } finally {
      await admin?.end();
    }
  });

  it('commit', async () => {
    let inside: Session | undefined;
    await driver.transaction(async () => {
      inside = await session();
      await run("INSERT INTO `log` (`who`) VALUES ('committed')");
    });

    expect(await logged()).to.deep.equal(['committed']);
    await expectClean(inside!, false);
  });

  it('rollback by a thrown error', async () => {
    let inside: Session | undefined;
    const outcome = await settle(
      driver.transaction(async () => {
        inside = await session();
        await run("INSERT INTO `log` (`who`) VALUES ('rolled-back')");
        throw new Error('boom');
      }),
    );

    expect(outcome).to.have.property('message', 'boom');
    expect(await logged()).to.deep.equal([]);
    await expectClean(inside!, false);
  });

  it('a deadlock: a statement issued in parallel with the deadlocked one is rolled back with the transaction', async () => {
    const other = await createConnection({ ...SERVER, database: DATABASE });
    const victimHolds = signal();
    const otherHolds = signal();
    let inside: Session | undefined;
    let deadlock: PromiseSettledResult<unknown> | undefined;
    let parallel: PromiseSettledResult<unknown> | undefined;

    try {
      const victim = settle(
        driver.transaction(async () => {
          inside = await session();
          await run("INSERT INTO `log` (`who`) VALUES ('victim-before')");
          await run('UPDATE `row` SET `v` = `v` + 1 WHERE `id` = 1', QueryContext.Update);
          victimHolds.open();
          await otherHolds.opened;
          // both are queued on the transaction's connection before the deadlock is known
          [deadlock, parallel] = await Promise.allSettled([run('UPDATE `row` SET `v` = `v` + 1 WHERE `id` = 2', QueryContext.Update), run("INSERT INTO `log` (`who`) VALUES ('parallel')")]);
        }),
      );
      const survivor = (async () => {
        await victimHolds.opened;
        await other.query('START TRANSACTION');
        // twenty rows make InnoDB pick the victim, which changed fewer
        await other.query(`INSERT INTO \`log\` (\`who\`) VALUES ${OTHER_ROWS.map(() => "('other')").join(', ')}`);
        await other.query('UPDATE `row` SET `v` = `v` + 1 WHERE `id` = 2');
        otherHolds.open();
        await lockWaitOf(inside!.id);
        await other.query('UPDATE `row` SET `v` = `v` + 1 WHERE `id` = 1');
        await other.query('COMMIT');
      })();

      const [outcome] = await Promise.all([victim, survivor]);

      expect(deadlock).to.have.nested.property('reason.inner.errno', 1213);
      expect(parallel).to.have.property('status', 'fulfilled');
      expect(outcome).to.be.instanceOf(TransactionAborted);
      expect(await logged()).to.deep.equal(OTHER_ROWS);
    } finally {
      await other.end();
    }
    await expectClean(inside!, false);
  });

  it('a failed COMMIT whose ROLLBACK succeeds', async () => {
    let inside: Session | undefined;
    driver.fault = 'commit';
    const outcome = await settle(
      driver.transaction(async () => {
        inside = await session();
        await run("INSERT INTO `log` (`who`) VALUES ('commit-failed')");
      }),
    );

    expect(outcome).to.have.property('message', 'injected COMMIT failure');
    expect(await logged()).to.deep.equal([]);
    driver.fault = undefined;
    await expectClean(inside!, false);
  });

  it('a failed ROLLBACK: the open transaction is not committed by a restore, the connection is destroyed', async () => {
    let inside: Session | undefined;
    driver.fault = 'rollback';
    const outcome = await settle(
      driver.transaction(async () => {
        inside = await session();
        await run("INSERT INTO `log` (`who`) VALUES ('rollback-failed')");
        throw new Error('boom');
      }),
    );

    expect(outcome).to.have.property('message', 'boom');
    driver.fault = undefined;
    await expectClean(inside!, true);
    expect(await logged()).to.deep.equal([]);
  });

  it('mysql2 reports a failed COMMIT and a failed ROLLBACK: no restore over the open transaction, the connection is destroyed', async () => {
    let inside: Session | undefined;
    driver.fault = 'replies';
    const outcome = await settle(
      driver.transaction(async () => {
        inside = await session();
        await run("INSERT INTO `log` (`who`) VALUES ('commit-reply-failed')");
      }),
    );

    expect(outcome).to.have.property('code', 'INJECTED');
    driver.fault = undefined;
    await expectClean(inside!, true);
    expect(await logged()).to.deep.equal([]);
  });

  it('mysql2 reports a failed ROLLBACK after a thrown error: no restore over the open transaction, the connection is destroyed', async () => {
    let inside: Session | undefined;
    driver.fault = 'replies';
    const outcome = await settle(
      driver.transaction(async () => {
        inside = await session();
        await run("INSERT INTO `log` (`who`) VALUES ('rollback-reply-failed')");
        throw new Error('boom');
      }),
    );

    expect(outcome).to.have.property('message', 'boom');
    driver.fault = undefined;
    await expectClean(inside!, true);
    expect(await logged()).to.deep.equal([]);
  });

  it('a failed SET autocommit = 1: the connection is destroyed, never pooled', async () => {
    let inside: Session | undefined;
    driver.fault = 'restore';
    await driver.transaction(async () => {
      inside = await session();
      await run("INSERT INTO `log` (`who`) VALUES ('committed')");
    });

    driver.fault = undefined;
    expect(await logged()).to.deep.equal(['committed']);
    await expectClean(inside!, true);
  });

  it('a connection lost mid-transaction', async () => {
    let inside: Session | undefined;
    let lost: unknown;
    const outcome = await settle(
      driver.transaction(async () => {
        inside = await session();
        await run("INSERT INTO `log` (`who`) VALUES ('lost')");
        await db().query(`KILL ${inside.id}`);
        lost = await settle(run('SELECT 1', QueryContext.Select));
        throw lost;
      }),
    );

    expect(outcome).to.equal(lost);
    expect(await logged()).to.deep.equal([]);
    await expectClean(inside!, true);
  });

  it('a nested transaction (savepoints) inside', async () => {
    let inside: Session | undefined;
    let nested: Session | undefined;
    await driver.transaction(async () => {
      inside = await session();
      await run("INSERT INTO `log` (`who`) VALUES ('outer')");
      await driver.transaction(async () => {
        nested = await session();
        await run("INSERT INTO `log` (`who`) VALUES ('kept')");
      });
      await settle(
        driver.transaction(async () => {
          await run("INSERT INTO `log` (`who`) VALUES ('dropped')");
          throw new Error('inner');
        }),
      );
    });

    expect(nested?.autocommit).to.equal(0);
    expect(await logged()).to.deep.equal(['kept', 'outer']);
    await expectClean(inside!, false);
  });

  it('a statement killed by KILL QUERY, the error rethrown', async () => {
    const holder = await createConnection({ ...SERVER, database: DATABASE });
    let inside: Session | undefined;
    let killed: unknown;

    try {
      await holder.query('START TRANSACTION');
      await holder.query('UPDATE `row` SET `v` = `v` + 10 WHERE `id` = 2');
      await settle(
        driver.transaction(async () => {
          inside = await session();
          await run("INSERT INTO `log` (`who`) VALUES ('killed')");
          const waiting = settle(run('UPDATE `row` SET `v` = `v` + 1 WHERE `id` = 2', QueryContext.Update));
          await lockWaitOf(inside.id);
          await db().query(`KILL QUERY ${inside.id}`);
          killed = await waiting;
          throw killed;
        }),
      );
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }

    expect(killed).to.have.nested.property('inner.errno', 1317);
    expect(await logged()).to.deep.equal([]);
    await expectClean(inside!, false);
  });

  it('DDL inside: its implicit commit keeps what came before; what came after is rolled back with the transaction', async () => {
    let inside: Session | undefined;
    try {
      await settle(
        driver.transaction(async () => {
          inside = await session();
          await run("INSERT INTO `log` (`who`) VALUES ('before-ddl')");
          await run('CREATE TABLE `ddl` (`id` INT) ENGINE=InnoDB', QueryContext.Schema);
          await run("INSERT INTO `log` (`who`) VALUES ('after-ddl')");
          throw new Error('boom');
        }),
      );

      expect(await logged()).to.deep.equal(['before-ddl']);
    } finally {
      await db().query(`DROP TABLE IF EXISTS \`${DATABASE}\`.\`ddl\``);
    }
    await expectClean(inside!, false);
  });

  it('the driver disconnected while a transaction is open', async () => {
    let inside: Session | undefined;
    try {
      const outcome = await settle(
        driver.transaction(async () => {
          inside = await session();
          await run("INSERT INTO `log` (`who`) VALUES ('disconnected')");
          await driver.disconnect();
          await run('SELECT 1', QueryContext.Select);
        }),
      );

      expect(outcome).to.be.instanceOf(Error);
      expect(await logged()).to.deep.equal([]);
    } finally {
      await driver.connect();
    }
    await expectClean(inside!, true);
  });

  it('a COMMIT and a ROLLBACK the server refuses (an XA transaction the callback left open)', async () => {
    let inside: Session | undefined;
    const outcome = await settle(
      driver.transaction(async () => {
        inside = await session();
        await run("INSERT INTO `log` (`who`) VALUES ('before-xa')");
        // the application ends the driver's transaction itself and opens an XA one: COMMIT and ROLLBACK now fail with 1399
        await run('COMMIT', QueryContext.Transaction);
        await run("XA START 'v4_sx_18c'", QueryContext.Transaction);
        await run("INSERT INTO `log` (`who`) VALUES ('in-xa')");
      }),
    );

    expect(outcome).to.have.property('errno', 1399);
    await expectClean(inside!, true);
    expect(await logged()).to.deep.equal(['before-xa']);
  });
});
