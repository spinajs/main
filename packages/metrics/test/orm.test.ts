/* eslint-disable prettier/prettier */
import { expect } from 'chai';
import 'mocha';
import * as client from 'prom-client';
import { OrmMetricsSink, ORM_METRIC_CONNECTION_STATE, ORM_METRIC_POOL_SIZE, ORM_METRIC_ACQUIRE_SECONDS } from '@spinajs/orm';
import { PromOrmMetricsSink } from '../src/orm.js';

describe('PromOrmMetricsSink', () => {
  beforeEach(() => {
    client.register.clear();
  });

  after(() => {
    client.register.clear();
  });

  it('is an OrmMetricsSink, so it can be registered over the ORM default', () => {
    expect(new PromOrmMetricsSink()).to.be.instanceOf(OrmMetricsSink);
  });

  it('publishes a gauge onto the default registry with its labels', async () => {
    const sink = new PromOrmMetricsSink();

    sink.gauge(ORM_METRIC_POOL_SIZE, 'Open ORM pool connections', { connection: 'db-a' }, 7);

    const out = await client.register.metrics();
    expect(out).to.contain(`${ORM_METRIC_POOL_SIZE}{connection="db-a"} 7`);
  });

  it('reuses the metric instead of re-registering it on every publish', async () => {
    const sink = new PromOrmMetricsSink();

    sink.gauge(ORM_METRIC_CONNECTION_STATE, 'state', { connection: 'db-b' }, 1);
    expect(() => sink.gauge(ORM_METRIC_CONNECTION_STATE, 'state', { connection: 'db-b' }, 0)).to.not.throw();

    const out = await client.register.metrics();
    expect(out).to.contain(`${ORM_METRIC_CONNECTION_STATE}{connection="db-b"} 0`);
  });

  it('records observations into a histogram', async () => {
    const sink = new PromOrmMetricsSink();

    sink.observe(ORM_METRIC_ACQUIRE_SECONDS, 'acquire seconds', { connection: 'db-c' }, 0.25);
    sink.observe(ORM_METRIC_ACQUIRE_SECONDS, 'acquire seconds', { connection: 'db-c' }, 0.75);

    const out = await client.register.metrics();
    expect(out).to.contain(`${ORM_METRIC_ACQUIRE_SECONDS}_count{connection="db-c"} 2`);
    expect(out).to.contain(`${ORM_METRIC_ACQUIRE_SECONDS}_sum{connection="db-c"} 1`);
  });
});
