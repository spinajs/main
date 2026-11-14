import { DI } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import sinon from 'sinon';
import { PostgresOrmDriver } from '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

describe('postgres stream (unit)', function () {
  this.timeout(15000);

  let driver: PostgresOrmDriver;

  beforeEach(async () => {
    driver = await DI.resolve(PostgresOrmDriver, [{ Name: 'pg-stream-unit', Driver: 'orm-driver-postgres' }]);
  });

  afterEach(() => DI.clearCache());

  const firstRow = () => driver.executeStreamOnDb('SELECT $1', [1], { batchSize: 10 })[Symbol.asyncIterator]().next();

  it('takes no client for parameters the cursor cannot serialize', async () => {
    const connect = sinon.spy();
    (driver as unknown as { Pool: unknown }).Pool = { connect };
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(driver.executeStreamOnDb('SELECT $1', [circular], { batchSize: 10 })[Symbol.asyncIterator]().next()).to.be.rejectedWith(TypeError);
    expect(connect.callCount).to.eq(0);
  });

  it('destroys the client when submitting the cursor throws', async () => {
    const release = sinon.spy();
    const client = { query: () => { throw new Error('not queryable'); }, release, once: () => client, removeListener: () => client };
    (driver as unknown as { Pool: unknown }).Pool = { connect: () => Promise.resolve(client) };

    await expect(firstRow()).to.be.rejected;
    expect(release.args).to.deep.equal([[true]]);
  });
});
