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
  public released = 0;

  public query(stmt: string, paramsOrCb: any, cb?: any) {
    const callback = typeof paramsOrCb === 'function' ? paramsOrCb : cb;
    this.statements.push(stmt);
    callback?.(null, []);
  }

  public beginTransaction(cb: (err?: unknown) => void) {
    this.events.push('begin');
    cb(null as any);
  }

  public commit(cb: (err?: unknown) => void) {
    this.events.push('commit');
    cb(null as any);
  }

  public rollback(cb: (err?: unknown) => void) {
    this.events.push('rollback');
    cb(null as any);
  }

  public release() {
    this.released++;
    this.events.push('release');
  }
}

class FakePool {
  public handedOut: FakePoolConnection[] = [];

  public getConnection(cb: (err: unknown, connection: FakePoolConnection) => void) {
    const connection = new FakePoolConnection();
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

    expect(driver.LastConnection.statements).to.deep.equal(['SAVEPOINT `sp_1`', 'RELEASE SAVEPOINT `sp_1`']);
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

    expect(driver.LastConnection.statements).to.deep.equal(['SAVEPOINT `sp_1`', 'ROLLBACK TO SAVEPOINT `sp_1`']);
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
