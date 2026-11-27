import { DI } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { OrmException, QueryContext } from '@spinajs/orm';
import pg from 'pg';
import sinon from 'sinon';
import { PostgresOrmDriver } from '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

function serverError(message: string, code: string): pg.DatabaseError {
  return Object.assign(new pg.DatabaseError(message, 0, 'error'), { code });
}

describe('postgres statement outside a transaction (unit)', function () {
  this.timeout(15000);

  let driver: PostgresOrmDriver;

  beforeEach(async () => {
    driver = await DI.resolve(PostgresOrmDriver, [{ Name: 'pg-abandoned-unit', Driver: 'orm-driver-postgres' }]);
  });

  afterEach(() => DI.clearCache());

  /** A pool whose one client answers `outcome` and records how it was released. */
  const usePool = (outcome: () => Promise<unknown>) => {
    const release = sinon.spy();
    (driver as unknown as { Pool: unknown }).Pool = { connect: () => Promise.resolve({ query: outcome, release }) };
    return release;
  };

  it('destroys the client when the statement got no answer from the server (pg query_timeout)', async () => {
    const timeout = new Error('Query read timeout');
    const release = usePool(() => Promise.reject(timeout));

    const err: unknown = await driver.executeOnDb('SELECT pg_sleep(4)', [], QueryContext.Select).then(
      () => expect.fail('the statement resolved'),
      (e: unknown) => e,
    );
    expect(err).to.be.instanceOf(OrmException).with.property('inner', timeout);
    expect(release.args).to.deep.equal([[true]]);
  });

  it('pools the client after an error the server answered, statement_timeout included', async () => {
    for (const refused of [serverError('relation "nope" does not exist', '42P01'), serverError('canceling statement due to statement timeout', '57014')]) {
      const release = usePool(() => Promise.reject(refused));
      await expect(driver.executeOnDb('SELECT * FROM nope', [], QueryContext.Select)).to.be.rejected;
      expect(release.callCount, refused.code).to.equal(1);
      expect(release.args[0][0], refused.code).to.not.be.ok;
    }
  });

  it('pools the client after a result', async () => {
    const release = usePool(() => Promise.resolve({ rows: [], rowCount: 0 }));
    await driver.executeOnDb('SELECT 1', [], QueryContext.Select);
    expect(release.callCount).to.equal(1);
    expect(release.args[0][0]).to.not.be.ok;
  });
});
