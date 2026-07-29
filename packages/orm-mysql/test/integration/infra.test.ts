/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Integration coverage for I2/I3/I4 against a **live** MySQL — the parts SQLite cannot prove:
 * MySQL's `insertId` path, MySQL composite-key DDL, real pool bookkeeping, and recovery across
 * a server restart.
 *
 *   docker compose --profile test up -d mysql
 *   npm run test:integration --workspace=@spinajs/orm-mysql
 *
 * Connection settings come from ORM_TEST_MYSQL_* (see README).
 */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { ConnectionState, Orm, ORM_METRIC_ACQUIRE_SECONDS, ORM_METRIC_POOL_SIZE, QueryContext } from '@spinajs/orm';
import { Metrics } from '@spinajs/telemetry-common';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { execSync } from 'child_process';
import _ from 'lodash';
import 'mocha';

import { MySqlOrmDriver } from '../../src/index.js';
import { MysqlAutoKey } from './models/MysqlAutoKey.js';
import { MysqlUuidKey } from './models/MysqlUuidKey.js';
import { MysqlCompositeKey } from './models/MysqlCompositeKey.js';
import './migrations/InfraMigration_2026_07_25_00_00_00.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

const HOST = process.env.ORM_TEST_MYSQL_HOST ?? '127.0.0.1';
const PORT = Number(process.env.ORM_TEST_MYSQL_PORT ?? 13306);
const USER = process.env.ORM_TEST_MYSQL_USER ?? 'root';
const PASSWORD = process.env.ORM_TEST_MYSQL_PASSWORD ?? 'root';
const DATABASE = process.env.ORM_TEST_MYSQL_DATABASE ?? 'test';

/**
 * Restart by CONTAINER NAME, not `docker compose restart`.
 *
 * `docker compose` only touches containers labelled with the compose project it computes from
 * the current directory. Run from a git worktree — or any directory whose basename differs from
 * the one that brought the container up — it matches nothing, prints nothing and **exits 0**.
 * The restart silently does not happen and a pool-recovery test passes for the wrong reason.
 * The container name is fixed in docker-compose.yml, so addressing it directly cannot miss.
 */
const CONTAINER = process.env.ORM_TEST_MYSQL_CONTAINER ?? 'spinajs-orm-test-mysql';

class InfraConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        logger: {
          targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
          rules: [{ name: '*', level: 'error', target: 'Empty' }],
        },
        db: {
          Migration: { Startup: false },
          Connections: [
            {
              Driver: 'orm-driver-mysql',
              Name: 'mysql',
              Host: HOST,
              Port: PORT,
              User: USER,
              Password: PASSWORD,
              Database: DATABASE,
              Pool: { Max: 2, IdleTimeout: 5000, AcquireTimeout: 5000 },
              Resilience: { HealthCheckInterval: 500, MaxRetries: 20, RetryDelay: 250, MaxRetryDelay: 2000 },
              // OnStartup MUST be true. `Orm.resolve()` migrates and then calls
              // `reloadTableInfo()` unconditionally, and the MySQL driver *throws*
              // `Table <db>.<name> does not exist` for a missing table where the SQLite driver
              // returns null. With OnStartup false the migration is skipped by design, so
              // resolve() fails before the suite can migrate by hand. That driver
              // inconsistency is deliberately NOT changed on this branch — see the I4
              // changelog entry in docs/orm-analysis.md.
              // Same ledger as the transaction suite on purpose. `@Migration` registers into DI
              // at import time, so once mocha has loaded both integration files EVERY suite's
              // Migration.up() runs EVERY migration. Two ledgers would mean each migration is
              // recorded in one of them and re-run from the other, failing on "table already
              // exists". One database, one ledger.
              Migration: { Table: 'orm_migrations_integration', OnStartup: true },
            },
          ],
        },
      },
      (target: any, source: any) => (_.isArray(target) ? target.concat(source) : undefined),
    );
  }
}

/**
 * The shared telemetry registry the ORM publishes into — a `@Singleton()`, so this resolves the
 * same instance the driver writes to. Reading the rendered exposition text proves the seam end to
 * end, through the real prom-client objects rather than a stand-in sink.
 */
function metrics(): Metrics {
  return DI.get(Metrics) ?? DI.resolve(Metrics);
}

function db() {
  return DI.get(Orm)!;
}

function driver() {
  return db().Connections.get('mysql')! as MySqlOrmDriver;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Seconds mysqld has been up. Resets on every server restart, so it is restart evidence. */
async function serverUptime(): Promise<number> {
  const rows = (await driver().executeOnDb("SHOW GLOBAL STATUS LIKE 'Uptime'", [], QueryContext.Select)) as Array<{ Value: string }>;
  return Number(rows[0].Value);
}

/** Polls until the driver can answer a query again, or the budget runs out. */
async function waitUntilQueryable(budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;

  for (;;) {
    try {
      await driver().executeOnDb('SELECT 1', [], QueryContext.Select);
      return;
    } catch (err) {
      if (Date.now() > deadline) {
        throw err;
      }
      await sleep(500);
    }
  }
}

describe('MySQL integration - orm-infra', function () {
  this.timeout(180000);

  before(async () => {
    DI.clearCache();
    DI.register(InfraConf).as(Configuration);
    DI.register(MySqlOrmDriver).as('orm-driver-mysql');

    await DI.resolve(Orm);
    await db().Migration.up();
    // Model descriptors get their columns from the live schema; without this the insert
    // compiler has no columns to work with.
    await db().reloadTableInfo();
  });

  beforeEach(async () => {
    await driver().truncate('mysql_auto_key');
    await driver().truncate('mysql_uuid_key');
    await driver().truncate('mysql_composite_key');
  });

  after(async () => {
    await driver().disconnect();
    DI.clearCache();
  });

  it('auto key: the model learns insertId from its own insert', async () => {
    const m = new MysqlAutoKey({ Name: 'a' });
    await m.insert();

    expect(m.Id).to.be.a('number').and.greaterThan(0);
    expect((await MysqlAutoKey.get(m.Id)).Name).to.equal('a');
  });

  it('auto key: a multi-row batch gets contiguous keys from one statement', async () => {
    // MySQL treats `INSERT ... VALUES (...), (...)` as a *simple insert* and reserves one
    // contiguous block of auto-increment values, even under innodb_autoinc_lock_mode = 2.
    const rows = [new MysqlAutoKey({ Name: 'b1' }), new MysqlAutoKey({ Name: 'b2' }), new MysqlAutoKey({ Name: 'b3' })];
    await MysqlAutoKey.insert(rows);

    const ids = rows.map((r) => r.Id);
    expect(ids.every((i) => typeof i === 'number' && i > 0)).to.equal(true);
    expect(ids[1]).to.equal(ids[0] + 1);
    expect(ids[2]).to.equal(ids[1] + 1);

    // and the keys actually address the rows the caller inserted, in order
    expect((await MysqlAutoKey.get(ids[0])).Name).to.equal('b1');
    expect((await MysqlAutoKey.get(ids[1])).Name).to.equal('b2');
    expect((await MysqlAutoKey.get(ids[2])).Name).to.equal('b3');
  });

  it('confirms the server really is in the interleaved auto-increment mode', async () => {
    const rows = (await driver().executeOnDb('SELECT @@innodb_autoinc_lock_mode AS m', [], QueryContext.Select)) as Array<{ m: number }>;

    // If this is not 2, the batch test above proves nothing about the mode the comment in
    // model.ts used to worry about.
    expect(rows[0].m).to.equal(2);
  });

  it('uuid key: the client-generated key survives the round-trip and is not overwritten', async () => {
    const m = new MysqlUuidKey({ Name: 'b' });
    await m.insert();

    expect(m.Id).to.be.a('string').with.length(36);
    expect((await MysqlUuidKey.get(m.Id)).Name).to.equal('b');
  });

  it('returning() throws NotSupported on MySQL', () => {
    expect(() => driver().insert().into('mysql_auto_key').values({ Name: 'x' }).returning(['Id'])).to.throw(/does not support RETURNING/);
  });

  it('composite key: DDL creates a two-column PRIMARY KEY', async () => {
    const info = await driver().tableInfo('mysql_composite_key', DATABASE);

    expect(info.filter((c) => c.PrimaryKey).map((c) => c.Name)).to.deep.equal(['TenantId', 'Code']);
  });

  it('composite key: get/update/destroy address exactly one row', async () => {
    await new MysqlCompositeKey({ TenantId: 1, Code: 'a', Name: 'A' }).insert();
    await new MysqlCompositeKey({ TenantId: 1, Code: 'b', Name: 'B' }).insert();

    const m = await MysqlCompositeKey.get([1, 'a']);
    m.Name = 'A2';
    await m.update();

    expect((await MysqlCompositeKey.get([1, 'a'])).Name).to.equal('A2');
    expect((await MysqlCompositeKey.get([1, 'b'])).Name).to.equal('B');

    await MysqlCompositeKey.destroy([[1, 'a']]);
    expect(await MysqlCompositeKey.get([1, 'a'])).to.be.undefined;
    expect((await MysqlCompositeKey.get([1, 'b'])).Name).to.equal('B');
  });

  it('composite key: find() returns exactly the named tuples', async () => {
    await new MysqlCompositeKey({ TenantId: 1, Code: 'a', Name: 'A' }).insert();
    await new MysqlCompositeKey({ TenantId: 2, Code: 'a', Name: 'C' }).insert();
    await new MysqlCompositeKey({ TenantId: 1, Code: 'b', Name: 'B' }).insert();

    const rows = await MysqlCompositeKey.find([
      [1, 'a'],
      [2, 'a'],
    ]);
    expect(rows.map((r) => r.Name).sort()).to.deep.equal(['A', 'C']);
  });

  it('pool metrics report real numbers within the configured maximum', async () => {
    await MysqlAutoKey.count();

    const m = driver().poolMetrics();
    expect(m.Size).to.be.at.least(1);
    expect(m.Size).to.be.at.most(2);
    expect(m.InUse).to.be.at.least(0);
  });

  it('the telemetry registry receives pool gauges and acquire observations', async () => {
    await MysqlAutoKey.count();
    driver().publishPoolMetrics();

    const out = await metrics().render();

    expect(out).to.match(new RegExp(`^${ORM_METRIC_ACQUIRE_SECONDS}_count\\{connection="mysql"\\} [1-9]`, 'm'));
    expect(out).to.match(new RegExp(`^${ORM_METRIC_POOL_SIZE}\\{connection="mysql"\\} `, 'm'));
  });

  it('a query error is not retried', async () => {
    const start = Date.now();

    await expect(driver().select().from('table_that_does_not_exist').select('*')).to.be.rejected;

    // A retried failure would have burned at least MaxRetries * RetryDelay of backoff.
    expect(Date.now() - start).to.be.lessThan(3000);
  });

  it('the pool recovers after the server restarts, without restarting the process', async () => {
    await new MysqlAutoKey({ Name: 'before' }).insert();

    const uptimeBefore = await serverUptime();

    execSync(`docker restart ${CONTAINER}`, { stdio: 'ignore' });

    // The driver must get itself back on its own: before I4 the pool held dead sockets forever
    // and every query after a restart failed with PROTOCOL_CONNECTION_LOST.
    await waitUntilQueryable(120000);

    // Proof the restart actually happened. Without this the test is green even when the
    // restart command silently no-ops.
    const uptimeAfter = await serverUptime();
    expect(uptimeAfter).to.be.lessThan(uptimeBefore);

    const rows = await MysqlAutoKey.all();
    expect(rows.map((r) => r.Name)).to.deep.equal(['before']);

    await new MysqlAutoKey({ Name: 'after' }).insert();
    expect(await MysqlAutoKey.count()).to.equal(2);

    expect(driver().State).to.equal(ConnectionState.Connected);
  });
});
