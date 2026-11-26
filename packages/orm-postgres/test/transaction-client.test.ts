import { DI } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import sinon from 'sinon';
import { PostgresOrmDriver } from '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

/** A pooled client that records its statements and fails the ones named in `failing`. */
function fakeClient(failing: Record<string, Error> = {}) {
  const statements: string[] = [];
  const failures = new Map(Object.entries(failing));
  const release = sinon.spy();
  const client = {
    query: (sql: string) => {
      statements.push(sql);
      const error = failures.get(sql);
      return error ? Promise.reject(error) : Promise.resolve({ rows: [], rowCount: 0 });
    },
    release,
  };
  return { client, statements, release };
}

describe('postgres transaction client (unit)', function () {
  this.timeout(15000);

  let driver: PostgresOrmDriver;

  beforeEach(async () => {
    driver = await DI.resolve(PostgresOrmDriver, [{ Name: 'pg-tx-unit', Driver: 'orm-driver-postgres' }]);
  });

  afterEach(() => DI.clearCache());

  const usePool = (client: unknown) => {
    (driver as unknown as { Pool: unknown }).Pool = { connect: () => Promise.resolve(client) };
  };

  it('destroys the client when SET TRANSACTION fails after BEGIN', async () => {
    const standby = new Error('cannot use serializable mode in a hot standby');
    const fake = fakeClient({ 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE': standby });
    usePool(fake.client);

    await expect(driver.transaction(async () => 1, { isolation: 'SERIALIZABLE' })).to.be.rejectedWith(standby.message);
    expect(fake.statements).to.deep.equal(['BEGIN', 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE']);
    expect(fake.release.args).to.deep.equal([[true]]);
  });

  it('destroys the client when BEGIN itself fails', async () => {
    const fake = fakeClient({ BEGIN: new Error('connection reset') });
    usePool(fake.client);

    await expect(driver.transaction(async () => 1)).to.be.rejectedWith('connection reset');
    expect(fake.release.args).to.deep.equal([[true]]);
  });

  it('destroys the client when ROLLBACK fails, and still throws what the transaction threw', async () => {
    const fake = fakeClient({ ROLLBACK: new Error('rollback failed') });
    usePool(fake.client);

    await expect(
      driver.transaction(async () => {
        throw new Error('the work failed');
      }),
    ).to.be.rejectedWith('the work failed');
    expect(fake.statements).to.deep.equal(['BEGIN', 'ROLLBACK']);
    expect(fake.release.args).to.deep.equal([[true]]);
  });

  it('pools the client after a rollback that succeeded', async () => {
    const fake = fakeClient();
    usePool(fake.client);

    await expect(driver.transaction(async () => Promise.reject(new Error('the work failed')))).to.be.rejectedWith('the work failed');
    expect(fake.release.args).to.deep.equal([[false]]);
  });
});
