/**
 * A statement that times out waiting for a row lock was answered by the server: the driver must surface the error after
 * one wait, not treat it as a lost connection (reconnect, replace the pool, wait again).
 *
 * Connection settings come from ORM_TEST_MYSQL_* (see README). The test creates and drops its own database.
 */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { ConnectionState, OrmException, QueryContext } from '@spinajs/orm';
import '@spinajs/log';
import { expect } from 'chai';
import 'mocha';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { MySqlOrmDriver } from '../../src/index.js';

const SERVER = {
  Host: process.env.ORM_TEST_MYSQL_HOST ?? '127.0.0.1',
  Port: Number(process.env.ORM_TEST_MYSQL_PORT ?? 13306),
  User: process.env.ORM_TEST_MYSQL_USER ?? 'root',
  Password: process.env.ORM_TEST_MYSQL_PASSWORD ?? 'root',
};
const DATABASE = `v4_ox_37_lock_wait_${randomUUID().slice(0, 8)}`;

class QuietConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.Config.logger = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] };
  }
}

class ObservedMySqlDriver extends MySqlOrmDriver {
  public states: ConnectionState[] = [];

  public get CurrentPool() {
    return this.Pool;
  }

  protected setState(state: ConnectionState): void {
    super.setState(state);
    this.states.push(state);
  }
}

describe('mysql lock wait timeout outside a transaction (integration)', function () {
  this.timeout(60000);

  let admin: MySqlOrmDriver;
  let waiter: ObservedMySqlDriver;
  const sql = (statement: string) => admin.executeOnDb(statement, [], QueryContext.Schema);

  before(async () => {
    DI.clearCache();
    DI.register(QuietConf).as(Configuration);
    admin = await DI.child().resolve(MySqlOrmDriver, [{ Name: 'lock-admin', Driver: 'orm-driver-mysql', ...SERVER, Database: 'mysql' }]);
    await admin.connect();
    await admin.schema().createDatabase(DATABASE);
    await sql(`CREATE TABLE \`${DATABASE}\`.item (Id INT PRIMARY KEY, Name VARCHAR(8) NOT NULL)`);
    await sql(`INSERT INTO \`${DATABASE}\`.item (Id, Name) VALUES (1, 'a')`);

    // The default Resilience (5 retries) on purpose; one pooled connection keeps the session setting observable.
    waiter = await DI.child().resolve(ObservedMySqlDriver, [{ Name: 'lock-waiter', Driver: 'orm-driver-mysql', ...SERVER, Database: DATABASE, Pool: { Max: 1 }, Resilience: { HealthCheckInterval: 0 } }]);
    await waiter.connect();
    // Through the pool, not schema(): a schema statement runs on a connection of its own.
    await waiter.executeOnDb('SET SESSION innodb_lock_wait_timeout = 1', [], QueryContext.Select);
  });

  after(async () => {
    await waiter?.disconnect();
    await sql(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
    await admin?.disconnect();
    DI.clearCache();
  });

  it('fails after one wait with the lock wait error, on the same pool and session', async () => {
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const holder = admin.transaction(async () => {
      await admin.executeOnDb(`SELECT Id FROM \`${DATABASE}\`.item WHERE Id = 1 FOR UPDATE`, [], QueryContext.Select);
      locked();
      await released;
    });
    await lockTaken;

    const pool = waiter.CurrentPool;
    waiter.states.length = 0;
    const started = Date.now();
    const update = waiter.executeOnDb(`UPDATE item SET Name = 'b' WHERE Id = 1`, [], QueryContext.Update).then(
      () => 'updated',
      (err: unknown) => err,
    );
    const outcome = await Promise.race([update, delay(5000, 'still waiting')]);
    const elapsed = Date.now() - started;
    release();
    await holder;
    await update;

    expect(outcome).to.be.instanceOf(OrmException).and.to.have.nested.property('inner.code', 'ER_LOCK_WAIT_TIMEOUT');
    expect(elapsed).to.be.within(900, 3000);
    expect(waiter.CurrentPool).to.equal(pool);
    expect(waiter.states).to.deep.equal([]);
    expect(waiter.State).to.equal(ConnectionState.Connected);
    expect(await waiter.executeOnDb('SELECT @@SESSION.innodb_lock_wait_timeout AS Timeout', [], QueryContext.Select)).to.deep.equal([{ Timeout: 1 }]);
  });
});
