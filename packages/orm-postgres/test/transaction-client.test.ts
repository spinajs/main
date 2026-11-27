import { DI } from '@spinajs/di';
import { OrmException } from '@spinajs/orm';
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

  describe('a nested ROLLBACK TO SAVEPOINT that failed', () => {
    const lost = new Error('Query read timeout');

    const failNested = () =>
      driver.transaction(async () => {
        throw new Error('the inner work failed');
      });

    it('refuses the commit after a nested ROLLBACK TO SAVEPOINT failed, rolls back and destroys the client', async () => {
      const fake = fakeClient({ 'ROLLBACK TO SAVEPOINT "sp_1"': lost });
      usePool(fake.client);
      const committed = sinon.spy();

      const err = await driver
        .transaction(async () => {
          await driver.afterCommit(committed);
          await failNested().catch(() => undefined);
          return 'the outer work';
        })
        .then(
          () => undefined,
          (e: unknown) => e,
        );

      expect(err).to.be.instanceOf(OrmException).with.property('inner', lost);
      expect((err as OrmException).message).to.contain('ROLLBACK TO SAVEPOINT of a nested transaction failed').and.contain('nothing of it was written');
      expect(fake.statements).to.deep.equal(['BEGIN', 'SAVEPOINT "sp_1"', 'ROLLBACK TO SAVEPOINT "sp_1"', 'ROLLBACK']);
      expect(fake.release.args).to.deep.equal([[true]]);
      expect(committed.called).to.equal(false);
    });

    it('destroys the client once when the ROLLBACK after the refusal fails too', async () => {
      const fake = fakeClient({ 'ROLLBACK TO SAVEPOINT "sp_1"': lost, ROLLBACK: new Error('Query read timeout') });
      usePool(fake.client);

      const outer = driver.transaction(async () => {
        await failNested().catch(() => undefined);
      });

      await expect(outer).to.be.rejectedWith(OrmException, 'nothing of it was written');
      expect(fake.statements).to.deep.equal(['BEGIN', 'SAVEPOINT "sp_1"', 'ROLLBACK TO SAVEPOINT "sp_1"', 'ROLLBACK']);
      expect(fake.release.args).to.deep.equal([[true]]);
    });

    it('commits after a nested ROLLBACK TO SAVEPOINT that reached the server', async () => {
      const fake = fakeClient();
      usePool(fake.client);

      const result = await driver.transaction(async () => {
        await failNested().catch(() => undefined);
        return 'the outer work';
      });

      expect(result).to.equal('the outer work');
      expect(fake.statements).to.deep.equal(['BEGIN', 'SAVEPOINT "sp_1"', 'ROLLBACK TO SAVEPOINT "sp_1"', 'COMMIT']);
      expect(fake.release.args).to.deep.equal([[false]]);
    });

    it('refuses when the lost one is two levels down and the level above it released its savepoint', async () => {
      const fake = fakeClient({ 'ROLLBACK TO SAVEPOINT "sp_2"': lost });
      usePool(fake.client);

      const outer = driver.transaction(async () => {
        await driver.transaction(async () => {
          await failNested().catch(() => undefined);
        });
      });

      await expect(outer).to.be.rejectedWith(OrmException, 'nothing of it was written');
      expect(fake.statements).to.deep.equal(['BEGIN', 'SAVEPOINT "sp_1"', 'SAVEPOINT "sp_2"', 'ROLLBACK TO SAVEPOINT "sp_2"', 'RELEASE SAVEPOINT "sp_1"', 'ROLLBACK']);
      expect(fake.release.args).to.deep.equal([[true]]);
    });

    it('still refuses after a later nested transaction of the same transaction completed', async () => {
      const fake = fakeClient({ 'ROLLBACK TO SAVEPOINT "sp_1"': lost });
      usePool(fake.client);

      const outer = driver.transaction(async () => {
        await failNested().catch(() => undefined);
        await driver.transaction(async () => 'a healthy nested call');
      });

      await expect(outer).to.be.rejectedWith(OrmException, 'nothing of it was written');
      expect(fake.statements.slice(-3)).to.deep.equal(['SAVEPOINT "sp_2"', 'RELEASE SAVEPOINT "sp_2"', 'ROLLBACK']);
    });

    it('still refuses after a later nested transaction rolled back to its own savepoint', async () => {
      const fake = fakeClient({ 'ROLLBACK TO SAVEPOINT "sp_1"': lost });
      usePool(fake.client);

      const outer = driver.transaction(async () => {
        await failNested().catch(() => undefined);
        await failNested().catch(() => undefined);
      });

      await expect(outer).to.be.rejectedWith(OrmException, 'nothing of it was written');
      expect(fake.statements.slice(-3)).to.deep.equal(['SAVEPOINT "sp_2"', 'ROLLBACK TO SAVEPOINT "sp_2"', 'ROLLBACK']);
      expect(fake.release.args).to.deep.equal([[true]]);
    });

    it('does not carry into the next transaction on the same async path and the same client', async () => {
      const fake = fakeClient({ 'ROLLBACK TO SAVEPOINT "sp_1"': lost });
      usePool(fake.client);

      await expect(driver.transaction(() => failNested().catch(() => undefined))).to.be.rejectedWith(OrmException);
      fake.statements.length = 0;

      expect(await driver.transaction(async () => 'the next work')).to.equal('the next work');
      expect(fake.statements).to.deep.equal(['BEGIN', 'COMMIT']);
      expect(fake.release.args).to.deep.equal([[true], [false]]);
    });
  });
});
