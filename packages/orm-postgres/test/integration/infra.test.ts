/* eslint-disable @typescript-eslint/no-explicit-any */
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { DI } from '@spinajs/di';
import { ConnectionState, ORM_METRIC_ACQUIRE_SECONDS, ORM_METRIC_POOL_SIZE, QueryContext } from '@spinajs/orm';
import { Metrics } from '@spinajs/telemetry-common';
import { execSync } from 'node:child_process';

import './migrations/PgCoreMigration_2026_10_15_00_00_00.js';
import { CONNECTION, IPgSuite, PG, dockerContainerAvailable, openSuite } from './harness.js';
import { PgAutoKey } from './models/core.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('postgres integration - infrastructure', function () {
  this.timeout(180000);
  let suite: IPgSuite;

  async function waitUntilQueryable(budgetMs: number): Promise<void> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      try {
        await suite.driver.executeOnDb('SELECT 1', [], QueryContext.Select);
        return;
      } catch (err) {
        if (Date.now() > deadline) {
          throw err;
        }
        await sleep(500);
      }
    }
  }

  before(async function () {
    suite = await openSuite(this, {
      name: 'infra',
      pool: { Max: 2, IdleTimeout: 5000, AcquireTimeout: 5000 },
      resilience: { HealthCheckInterval: 500, MaxRetries: 20, RetryDelay: 250, MaxRetryDelay: 2000 },
    });
  });

  beforeEach(async () => {
    await suite.reset('pg_auto_key');
  });

  after(async () => {
    await suite?.close();
  });

  it('publishes pool gauges and acquire observations to the telemetry registry', async () => {
    await PgAutoKey.all();
    suite.driver.publishPoolMetrics();

    const out = await (DI.get(Metrics) ?? DI.resolve(Metrics)).render();

    expect(out).to.match(new RegExp(`^${ORM_METRIC_ACQUIRE_SECONDS}_count\\{connection="${CONNECTION}"\\} [1-9]`, 'm'));
    expect(out).to.match(new RegExp(`^${ORM_METRIC_POOL_SIZE}\\{connection="${CONNECTION}"\\} `, 'm'));
  });

  it('does not retry a query error', async () => {
    const start = Date.now();
    await expect(suite.driver.select().from('table_that_does_not_exist').select('*')).to.be.rejected;
    expect(Date.now() - start).to.be.lessThan(3000);
  });

  it('recovers the pool after the server restarts, without restarting the process', async function () {
    if (!dockerContainerAvailable()) {
      console.warn(`      docker container ${PG.Container} not found, restart test skipped (set ORM_TEST_POSTGRES_CONTAINER)`);
      this.skip();
    }

    await new PgAutoKey({ Name: 'before' }).insert();
    const [{ started: before }] = await suite.raw<{ started: Date }[]>('SELECT pg_postmaster_start_time() AS started');

    // by container name: `docker compose restart` silently matches nothing outside the compose project directory
    execSync(`docker restart ${PG.Container}`, { stdio: 'ignore' });
    await waitUntilQueryable(120000);

    const [{ started: after }] = await suite.raw<{ started: Date }[]>('SELECT pg_postmaster_start_time() AS started');
    expect(after.getTime()).to.be.greaterThan(before.getTime());

    expect((await PgAutoKey.all()).map((r) => r.Name)).to.deep.equal(['before']);
    await new PgAutoKey({ Name: 'after' }).insert();
    expect((await PgAutoKey.all()).length).to.equal(2);
    expect(suite.driver.State).to.equal(ConnectionState.Connected);
  });
});
