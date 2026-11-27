import { OrmException, QueryContext, TransactionAborted } from '@spinajs/orm';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';

import { MySqlOrmDriver } from '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

type Callback = (err: Error | null, results?: unknown) => void;

const mysqlError = (message: string, errno: number, code: string, sqlState: string) => Object.assign(new Error(message), { errno, code, sqlState });
const DEADLOCK = mysqlError('Deadlock found when trying to get lock; try restarting transaction', 1213, 'ER_LOCK_DEADLOCK', '40001');
const LOCK_WAIT = mysqlError('Lock wait timeout exceeded; try restarting transaction', 1205, 'ER_LOCK_WAIT_TIMEOUT', 'HY000');
const LOCK_TABLE_FULL = mysqlError('The total number of locks exceeds the lock table size', 1206, 'ER_LOCK_TABLE_FULL', 'HY000');
const DUPLICATE = mysqlError("Duplicate entry '1' for key 't.PRIMARY'", 1062, 'ER_DUP_ENTRY', '23000');
const INTERRUPTED = mysqlError('Query execution was interrupted', 1317, 'ER_QUERY_INTERRUPTED', '70100');

const UPDATE = 'UPDATE `t` SET `v` = 1 WHERE `id` = 2';
const INSERT = 'INSERT INTO `t` (`v`) VALUES (1)';
const ON_TIMEOUT = 'SELECT @@innodb_rollback_on_timeout AS on_timeout';

/** A mysql2 PoolConnection stand-in: records statements and lifecycle events, fails the statements named in `failing`. */
class FakeConnection {
  public readonly statements: string[] = [];
  public readonly events: string[] = [];

  constructor(
    private readonly failing: ReadonlyMap<string, Error>,
    private readonly rollbackOnTimeout: number,
  ) {}

  public query(stmt: string, paramsOrCb: unknown, cb?: Callback): void {
    const callback = typeof paramsOrCb === 'function' ? (paramsOrCb as Callback) : cb;
    this.statements.push(stmt);
    if (stmt === ON_TIMEOUT) return callback?.(null, [{ on_timeout: this.rollbackOnTimeout }]);
    callback?.(this.failing.get(stmt) ?? null, []);
  }

  public beginTransaction(cb: Callback): void {
    this.events.push('begin');
    cb(null);
  }

  public commit(cb: Callback): void {
    this.events.push('commit');
    cb(null);
  }

  public rollback(cb: Callback): void {
    this.events.push('rollback');
    cb(null);
  }

  public release(): void {
    this.events.push('release');
  }
}

/** The driver on a fake pool that hands out a new FakeConnection per acquire. */
class StandInDriver extends MySqlOrmDriver {
  public readonly connections: FakeConnection[] = [];

  constructor(failing: Record<string, Error>, rollbackOnTimeout = 0) {
    super({ Driver: 'orm-driver-mysql', Name: 'mysql-server-rollback' });
    const pool = {
      getConnection: (cb: (err: Error | null, connection: FakeConnection) => void) => {
        const connection = new FakeConnection(new Map(Object.entries(failing)), rollbackOnTimeout);
        this.connections.push(connection);
        cb(null, connection);
      },
    };
    // the package's unit-test idiom (transaction-unit.test.ts): the pool and the log are fakes, nothing connects
    (this as unknown as { Pool: unknown }).Pool = pool;
    (this as unknown as { Log: unknown }).Log = { timeStart: () => undefined, timeEnd: () => 0, write: () => Promise.resolve(), info: () => undefined, warn: () => undefined, trace: () => undefined, error: () => undefined };
  }
}

const settle = (p: Promise<unknown>): Promise<unknown> => p.then((value) => value, (err: unknown) => err);
const run = (driver: StandInDriver, sql: string) => driver.executeOnDb(sql, [], QueryContext.Update);

describe('MySQL transaction the server rolled back (unit)', () => {
  it('refuses the statements and the commit after a caught deadlock, and runs no afterCommit callback', async () => {
    const driver = new StandInDriver({ [UPDATE]: DEADLOCK });
    const ran: string[] = [];
    let later: unknown;

    const outcome = await settle(
      driver.transaction(async () => {
        await driver.afterCommit(() => {
          ran.push('afterCommit');
        });
        // the application catches the deadlock and goes on
        await settle(run(driver, UPDATE));
        later = await settle(run(driver, INSERT));
        return 'the-value';
      }),
    );

    expect(later).to.be.instanceOf(TransactionAborted);
    expect(outcome).to.be.instanceOf(TransactionAborted);
    expect((outcome as Error).message).to.include('was rolled back by MySQL');
    expect(outcome).to.have.nested.property('inner.errno', 1213);
    expect(ran).to.deep.equal([]);
    expect(driver.connections[0].statements).to.deep.equal([UPDATE]);
    expect(driver.connections[0].events).to.deep.equal(['begin', 'rollback', 'release']);
  });

  it('refuses a statement retried inside the transaction on every try, telling the caller to retry the whole transaction', async () => {
    const driver = new StandInDriver({ [UPDATE]: DEADLOCK });
    const retries: unknown[] = [];

    const outcome = await settle(
      driver.transaction(async () => {
        await settle(run(driver, UPDATE));
        // a bounded statement-level retry, the pattern the docs now warn against
        for (let i = 0; i < 3; i++) retries.push(await settle(run(driver, UPDATE)));
      }),
    );

    expect(retries.map((r) => r instanceof TransactionAborted)).to.deep.equal([true, true, true]);
    expect((retries[0] as Error).message).to.include('retry the whole transaction');
    expect(retries[0]).to.have.nested.property('inner.errno', 1213);
    expect(outcome).to.be.instanceOf(TransactionAborted);
    // a subclass, so an existing `catch` that tests for OrmException still sees it
    expect(outcome).to.be.instanceOf(OrmException);
    expect(driver.connections[0].statements).to.deep.equal([UPDATE]);
  });

  it('keeps the transaction after a caught duplicate key or interrupted statement: MySQL undoes that statement only', async () => {
    for (const failure of [DUPLICATE, INTERRUPTED]) {
      const driver = new StandInDriver({ [INSERT]: failure });
      const ran: string[] = [];

      const outcome = await settle(
        driver.transaction(async () => {
          await driver.afterCommit(() => {
            ran.push('afterCommit');
          });
          await settle(run(driver, INSERT));
          await run(driver, UPDATE);
          return 'the-value';
        }),
      );

      expect(outcome).to.equal('the-value');
      expect(ran).to.deep.equal(['afterCommit']);
      expect(driver.connections[0].statements).to.deep.equal([INSERT, UPDATE]);
      expect(driver.connections[0].events).to.deep.equal(['begin', 'commit', 'release']);
    }
  });

  it('ends the transaction after a lock wait timeout only when the server runs with innodb_rollback_on_timeout', async () => {
    for (const [setting, ends] of [
      [0, false],
      [1, true],
    ] as const) {
      const driver = new StandInDriver({ [UPDATE]: LOCK_WAIT }, setting);

      const outcome = await settle(
        driver.transaction(async () => {
          await settle(run(driver, UPDATE));
          return 'the-value';
        }),
      );

      expect(driver.connections[0].statements).to.deep.equal([UPDATE, ON_TIMEOUT]);
      if (ends) {
        expect(outcome).to.be.instanceOf(TransactionAborted);
        expect(outcome).to.have.nested.property('inner.errno', 1205);
      } else {
        expect(outcome).to.equal('the-value');
      }
    }
  });

  it('ends the transaction after a full lock table, which InnoDB rolls back whole', async () => {
    const driver = new StandInDriver({ [UPDATE]: LOCK_TABLE_FULL });

    const outcome = await settle(
      driver.transaction(async () => {
        await settle(run(driver, UPDATE));
        return 'the-value';
      }),
    );

    expect(outcome).to.be.instanceOf(TransactionAborted);
    expect(outcome).to.have.nested.property('inner.errno', 1206);
  });

  it('refuses a savepoint after a caught deadlock and does not roll back to one the server already dropped', async () => {
    const driver = new StandInDriver({ [UPDATE]: DEADLOCK });
    let nested: unknown;
    let second: unknown;

    const outcome = await settle(
      driver.transaction(async () => {
        nested = await settle(driver.transaction(() => run(driver, UPDATE)));
        second = await settle(driver.transaction(async () => 'inner'));
      }),
    );

    expect(nested).to.have.nested.property('inner.errno', 1213);
    expect(second).to.be.instanceOf(TransactionAborted);
    expect(outcome).to.be.instanceOf(TransactionAborted);
    expect(driver.connections[0].statements).to.deep.equal(['SAVEPOINT `sp_1`', UPDATE]);
  });
});
