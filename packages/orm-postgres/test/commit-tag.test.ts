import { DI } from '@spinajs/di';
import { OrmException } from '@spinajs/orm';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import sinon from 'sinon';
import { PostgresOrmDriver } from '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

/** A pooled client whose COMMIT reports `commitTag` as the server's command tag (none when undefined). */
function fakeClient(commitTag: string | undefined) {
  const statements: string[] = [];
  const release = sinon.spy();
  const client = {
    query: (sql: string) => {
      statements.push(sql);
      return Promise.resolve(sql === 'COMMIT' && commitTag !== undefined ? { rows: [], rowCount: 0, command: commitTag } : { rows: [], rowCount: 0 });
    },
    release,
  };
  return { client, statements, release };
}

describe('postgres commit command tag (unit)', function () {
  this.timeout(15000);

  let driver: PostgresOrmDriver;

  beforeEach(async () => {
    driver = await DI.resolve(PostgresOrmDriver, [{ Name: 'pg-commit-tag-unit', Driver: 'orm-driver-postgres' }]);
  });

  afterEach(() => DI.clearCache());

  const usePool = (...clients: unknown[]) => {
    (driver as unknown as { Pool: unknown }).Pool = { connect: () => Promise.resolve(clients.shift()) };
  };

  it('rejects a transaction whose COMMIT the server answered with ROLLBACK, and runs no afterCommit callback', async () => {
    const fake = fakeClient('ROLLBACK');
    usePool(fake.client);
    const committed = sinon.spy();

    await expect(
      driver.transaction(async () => {
        await driver.afterCommit(committed);
        return 'the-value';
      }),
    ).to.be.rejectedWith(OrmException, 'aborted by an earlier failed statement');
    expect(committed.called).to.equal(false);
    expect(fake.statements).to.deep.equal(['BEGIN', 'COMMIT', 'ROLLBACK']);
    expect(fake.release.calledOnce).to.equal(true);
    expect(fake.release.calledWith(true)).to.equal(false);
  });

  it('leaves no transaction behind: the next transaction on the same async path opens its own and commits', async () => {
    const refused = fakeClient('ROLLBACK');
    const next = fakeClient('COMMIT');
    usePool(refused.client, next.client);
    const ran: string[] = [];

    await driver
      .transaction(async () => {
        await driver.afterCommit(() => {
          ran.push('refused');
        });
      })
      .catch(() => undefined);

    expect(driver.CurrentTransaction).to.equal(undefined);
    const result = await driver.transaction(async () => {
      await driver.afterCommit(() => {
        ran.push('next');
      });
      return 'next-value';
    });

    expect(result).to.equal('next-value');
    expect(ran).to.deep.equal(['next']);
    expect(next.statements).to.deep.equal(['BEGIN', 'COMMIT']);
    expect(refused.release.calledOnce).to.equal(true);
    expect(next.release.calledOnce).to.equal(true);
  });

  it('commits when the server answers COMMIT, and when a client reports no tag', async () => {
    for (const tag of ['COMMIT', undefined]) {
      const fake = fakeClient(tag);
      usePool(fake.client);
      const committed = sinon.spy();

      const result = await driver.transaction(async () => {
        await driver.afterCommit(committed);
        return 'the-value';
      });

      expect(result).to.equal('the-value');
      expect(committed.calledOnce).to.equal(true);
      expect(fake.statements).to.deep.equal(['BEGIN', 'COMMIT']);
      expect(fake.release.calledOnce).to.equal(true);
    }
  });
});
