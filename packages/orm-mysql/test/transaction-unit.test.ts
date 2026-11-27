/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';

import { MySqlOrmDriver } from '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

/**
 * Minimal stand-in for a `mysql2` PoolConnection. Records the SQL it is asked to run and the
 * lifecycle callbacks the driver invokes, so the transaction primitives can be verified without
 * a live server. The live-database coverage lives in `test/integration/transaction.test.ts`.
 */
class FakePoolConnection {
  public statements: string[] = [];
  public events: string[] = [];
  /** Statements and lifecycle events in the order they happened. */
  public trace: string[] = [];
  public released = 0;

  /** `failing` names the statements and lifecycle events ('begin', 'commit', 'rollback') that fail. */
  constructor(private readonly failing: ReadonlySet<string> = new Set()) {}

  public query(stmt: string, paramsOrCb: any, cb?: any) {
    const callback = typeof paramsOrCb === 'function' ? paramsOrCb : cb;
    this.statements.push(stmt);
    this.trace.push(stmt);
    callback?.(this.failure(stmt), []);
  }

  public beginTransaction(cb: (err?: unknown) => void) {
    this.lifecycle('begin', cb);
  }

  public commit(cb: (err?: unknown) => void) {
    this.lifecycle('commit', cb);
  }

  public rollback(cb: (err?: unknown) => void) {
    this.lifecycle('rollback', cb);
  }

  public release() {
    this.released++;
    this.events.push('release');
    this.trace.push('release');
  }

  public destroy() {
    this.events.push('destroy');
    this.trace.push('destroy');
  }

  private lifecycle(event: string, cb: (err?: unknown) => void) {
    this.events.push(event);
    this.trace.push(event);
    cb(this.failure(event));
  }

  private failure(name: string): Error | null {
    return this.failing.has(name) ? new Error(`${name} failed`) : null;
  }
}

class FakePool {
  public handedOut: FakePoolConnection[] = [];
  public failing = new Set<string>();

  public getConnection(cb: (err: unknown, connection: FakePoolConnection) => void) {
    const connection = new FakePoolConnection(this.failing);
    this.handedOut.push(connection);
    cb(null, connection);
  }

  public query(_stmt: string, paramsOrCb: any, cb?: any) {
    const callback = typeof paramsOrCb === 'function' ? paramsOrCb : cb;
    callback?.(null, []);
  }
}

/**
 * Exposes the protected primitives and swaps the pool for a fake. Everything else — the
 * commit/rollback/dispose ordering — is inherited from `OrmDriver`.
 */
class TestableMySqlDriver extends MySqlOrmDriver {
  public FakePool = new FakePool();

  constructor() {
    super({ Driver: 'orm-driver-mysql', Name: 'mysql-unit' } as any);
    (this as any).Pool = this.FakePool;
    (this as any).Log = {
      timeStart: () => undefined,
      timeEnd: () => 0,
      write: () => Promise.resolve(),
    };
  }

  public get LastConnection() {
    return this.FakePool.handedOut[this.FakePool.handedOut.length - 1];
  }
}

describe('MySQL transaction primitives', () => {
  it('acquires a connection, commits and releases it exactly once', async () => {
    const driver = new TestableMySqlDriver();

    await driver.transaction(async () => 'ok');

    expect(driver.FakePool.handedOut).to.have.length(1);
    expect(driver.LastConnection.events).to.deep.equal(['begin', 'commit', 'release']);
    expect(driver.LastConnection.released).to.equal(1);
  });

  it('rolls back and still releases the connection when the callback throws', async () => {
    const driver = new TestableMySqlDriver();

    await expect(
      driver.transaction(async () => {
        throw new Error('boom');
      }),
    ).to.be.rejectedWith('boom');

    expect(driver.LastConnection.events).to.deep.equal(['begin', 'rollback', 'release']);
    expect(driver.LastConnection.released).to.equal(1);
  });

  it('issues SAVEPOINT / RELEASE SAVEPOINT for a nested transaction', async () => {
    const driver = new TestableMySqlDriver();

    await driver.transaction(async () => {
      await driver.transaction(async () => 'inner');
    });

    expect(driver.LastConnection.statements).to.deep.equal(['SET autocommit = 0', 'SAVEPOINT `sp_1`', 'RELEASE SAVEPOINT `sp_1`', 'SET autocommit = 1']);
    // one connection for the whole nest — nesting must not acquire a second one
    expect(driver.FakePool.handedOut).to.have.length(1);
  });

  it('issues ROLLBACK TO SAVEPOINT when only the nested block fails', async () => {
    const driver = new TestableMySqlDriver();

    await driver.transaction(async () => {
      await driver
        .transaction(async () => {
          throw new Error('inner');
        })
        .catch(() => undefined);
    });

    expect(driver.LastConnection.statements).to.deep.equal(['SET autocommit = 0', 'SAVEPOINT `sp_1`', 'ROLLBACK TO SAVEPOINT `sp_1`', 'SET autocommit = 1']);
    expect(driver.LastConnection.events).to.deep.equal(['begin', 'commit', 'release']);
  });

  it('sets the isolation level before beginning the transaction', async () => {
    const driver = new TestableMySqlDriver();

    await driver.transaction(async () => 'ok', { isolation: 'SERIALIZABLE' });

    expect(driver.LastConnection.statements[0]).to.equal('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
  });

  it('declares support for all four standard isolation levels', () => {
    const driver = new TestableMySqlDriver();

    expect(driver.SupportedIsolationLevels).to.deep.equal(['READ UNCOMMITTED', 'READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE']);
  });

  it('never acquires a connection when the isolation level is unsupported', async () => {
    const driver = new TestableMySqlDriver();
    (driver as any).SupportedIsolationLevels = ['READ COMMITTED'];

    await expect(driver.transaction(async () => 1, { isolation: 'SERIALIZABLE' })).to.be.rejected;
    expect(driver.FakePool.handedOut).to.have.length(0);
  });
});

describe('MySQL transaction session: autocommit', () => {
  const fail = async () => {
    throw new Error('boom');
  };

  it('switches autocommit off before begin and back on before the connection returns to the pool, on commit and on rollback', async () => {
    const committed = new TestableMySqlDriver();
    await committed.transaction(async () => 'ok', { isolation: 'SERIALIZABLE' });
    expect(committed.LastConnection.trace).to.deep.equal(['SET TRANSACTION ISOLATION LEVEL SERIALIZABLE', 'SET autocommit = 0', 'begin', 'commit', 'SET autocommit = 1', 'release']);

    const rolledBack = new TestableMySqlDriver();
    await expect(rolledBack.transaction(fail)).to.be.rejectedWith('boom');
    expect(rolledBack.LastConnection.trace).to.deep.equal(['SET autocommit = 0', 'begin', 'rollback', 'SET autocommit = 1', 'release']);
  });

  it('destroys the connection when SET autocommit = 1 fails, so no later user gets a session that never commits', async () => {
    const driver = new TestableMySqlDriver();
    driver.FakePool.failing.add('SET autocommit = 1');

    await driver.transaction(async () => 'ok');

    expect(driver.LastConnection.trace).to.deep.equal(['SET autocommit = 0', 'begin', 'commit', 'SET autocommit = 1', 'destroy']);
  });

  it('destroys the connection without restoring autocommit when no COMMIT or ROLLBACK succeeded: the restore would commit the open transaction', async () => {
    const driver = new TestableMySqlDriver();
    driver.FakePool.failing.add('commit').add('rollback');

    await expect(driver.transaction(async () => 'ok')).to.be.rejectedWith('commit failed');

    expect(driver.LastConnection.trace).to.deep.equal(['SET autocommit = 0', 'begin', 'commit', 'rollback', 'destroy']);
  });

  it('restores autocommit after a failed COMMIT whose ROLLBACK succeeded', async () => {
    const driver = new TestableMySqlDriver();
    driver.FakePool.failing.add('commit');

    await expect(driver.transaction(async () => 'ok')).to.be.rejectedWith('commit failed');

    expect(driver.LastConnection.trace).to.deep.equal(['SET autocommit = 0', 'begin', 'commit', 'rollback', 'SET autocommit = 1', 'release']);
  });

  it('destroys the connection when the transaction cannot begin after its session was changed', async () => {
    for (const step of ['SET autocommit = 0', 'begin']) {
      const driver = new TestableMySqlDriver();
      driver.FakePool.failing.add(step);

      await expect(driver.transaction(async () => 'ok')).to.be.rejectedWith(`${step} failed`);

      expect(driver.LastConnection.trace.at(-1)).to.equal('destroy');
      expect(driver.LastConnection.released).to.equal(0);
    }
  });
});
