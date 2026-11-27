import { DI } from '@spinajs/di';
import { OrmException, QueryContext } from '@spinajs/orm';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import pg from 'pg';
import sinon from 'sinon';
import { PostgresOrmDriver } from '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

/** A server error as node-postgres raises it. */
function pgError(code: string, message: string): Error {
  return Object.assign(new pg.DatabaseError(message, 0, 'error'), { code, severity: 'ERROR' });
}

/** A pooled client whose COMMIT reports `commitTag` as the server's command tag (none when undefined); a statement in `failing` rejects with its error. */
function fakeClient(commitTag: string | undefined, failing: ReadonlyMap<string, Error> = new Map()) {
  const statements: string[] = [];
  const release = sinon.spy();
  const client = {
    query: (sql: string) => {
      statements.push(sql);
      const failure = failing.get(sql);
      if (failure) return Promise.reject(failure);
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

  it('carries the first failed statement of the refused transaction as inner', async () => {
    const missing = pgError('42P01', 'relation "no_such_table" does not exist');
    const fake = fakeClient(
      'ROLLBACK',
      new Map([
        ['SELECT * FROM no_such_table', missing],
        ['SELECT 1', pgError('25P02', 'current transaction is aborted')],
      ]),
    );
    usePool(fake.client);

    const err = await driver
      .transaction(async () => {
        await driver.executeOnDb('SELECT * FROM no_such_table', [], QueryContext.Select).catch(() => undefined);
        await driver.executeOnDb('SELECT 1', [], QueryContext.Select).catch(() => undefined);
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(err).to.be.instanceOf(OrmException);
    const inner = (err as OrmException).inner;
    expect(inner).to.be.instanceOf(OrmException);
    expect((inner as OrmException).inner).to.equal(missing);
    expect((err as Error).message).to.include('no_such_table');
  });

  it('forgets a failure rolled back to its savepoint: a later refusal names the later failure', async () => {
    const healed = pgError('42P01', 'relation "healed_table" does not exist');
    const later = pgError('42703', 'column "no_such_column" does not exist');
    const fake = fakeClient(
      'ROLLBACK',
      new Map([
        ['SELECT * FROM healed_table', healed],
        ['SELECT no_such_column', later],
      ]),
    );
    usePool(fake.client);

    const err = await driver
      .transaction(async () => {
        await driver
          .transaction(async () => {
            await driver.executeOnDb('SELECT * FROM healed_table', [], QueryContext.Select);
          })
          .catch(() => undefined);
        await driver.executeOnDb('SELECT no_such_column', [], QueryContext.Select).catch(() => undefined);
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(err).to.be.instanceOf(OrmException);
    const inner = (err as OrmException).inner;
    expect(inner).to.be.instanceOf(OrmException);
    expect((inner as OrmException).inner).to.equal(later);
    expect((err as Error).message).to.include('no_such_column');
    expect((err as Error).message).to.not.include('healed_table');
  });
});
