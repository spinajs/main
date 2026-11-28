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
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { MySqlOrmDriver } from '../../src/index.js';

const SERVER = {
  Host: process.env.ORM_TEST_MYSQL_HOST ?? '127.0.0.1',
  Port: Number(process.env.ORM_TEST_MYSQL_PORT ?? 13306),
  User: process.env.ORM_TEST_MYSQL_USER ?? 'root',
  Password: process.env.ORM_TEST_MYSQL_PASSWORD ?? 'root',
};
const DATABASE = `v4_ox_37_lock_wait_${randomUUID().slice(0, 8)}`;

function reachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: SERVER.Host, port: SERVER.Port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

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

  // Assigned only once connected, so a failed before() leaves nothing for after() to retry against.
  let adminDriver: MySqlOrmDriver | undefined;
  let waiterDriver: ObservedMySqlDriver | undefined;

  before(async function () {
    if (!(await reachable())) {
      console.warn(`      MySQL at ${SERVER.Host}:${SERVER.Port} is unreachable, suite skipped`);
      this.skip();
    }

    DI.clearCache();
    DI.register(QuietConf).as(Configuration);
    const owner = await DI.child().resolve(MySqlOrmDriver, [{ Name: 'lock-admin', Driver: 'orm-driver-mysql', ...SERVER, Database: 'mysql' }]);
    await owner.connect();
    adminDriver = owner;
    const sql = (statement: string) => owner.executeOnDb(statement, [], QueryContext.Schema);
    await owner.schema().createDatabase(DATABASE);
    await sql(`CREATE TABLE \`${DATABASE}\`.item (Id INT PRIMARY KEY, Name VARCHAR(8) NOT NULL)`);
    await sql(`INSERT INTO \`${DATABASE}\`.item (Id, Name) VALUES (1, 'a')`);

    // The default Resilience (5 retries) on purpose; one pooled connection keeps the session setting observable.
    const other = await DI.child().resolve(ObservedMySqlDriver, [{ Name: 'lock-waiter', Driver: 'orm-driver-mysql', ...SERVER, Database: DATABASE, Pool: { Max: 1 }, Resilience: { HealthCheckInterval: 0 } }]);
    await other.connect();
    waiterDriver = other;
    // Through the pool, not schema(): a schema statement runs on a connection of its own.
    await other.executeOnDb('SET SESSION innodb_lock_wait_timeout = 1', [], QueryContext.Select);
  });

  after(async () => {
    await adminDriver?.executeOnDb(`DROP DATABASE IF EXISTS \`${DATABASE}\``, [], QueryContext.Schema);
    await waiterDriver?.disconnect();
    await adminDriver?.disconnect();
    DI.clearCache();
  });

  it('fails after one wait with the lock wait error, on the same pool and session', async () => {
    const admin = adminDriver;
    const waiter = waiterDriver;
    if (!admin || !waiter) throw new Error('the suite did not connect');
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
    expect(elapsed).to.be.at.least(900);
    expect(waiter.CurrentPool).to.equal(pool);
    expect(waiter.states).to.deep.equal([]);
    expect(waiter.State).to.equal(ConnectionState.Connected);
    expect(await waiter.executeOnDb('SELECT @@SESSION.innodb_lock_wait_timeout AS Timeout', [], QueryContext.Select)).to.deep.equal([{ Timeout: 1 }]);
  });
});
