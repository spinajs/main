import 'mocha';
import { expect } from 'chai';

import { DI } from '@spinajs/di';
import { IdentifierQuoter } from '@spinajs/orm';

import { PostgresOrmDriver, PostgresServerResponseMapper, toPositionalParameters } from '../src/index.js';

/**
 * Postgres' side of the dialect contract.
 *
 * No database: resolving the driver registers its dialect classes into its own container,
 * and a statement can be built and inspected without anything to run it against — same
 * shape as the mysql and mssql dialect suites, so it runs in CI without a fixture.
 */
describe('postgres dialect', function () {
  this.timeout(15000);

  let driver: PostgresOrmDriver;

  beforeEach(async () => {
    driver = await DI.resolve(PostgresOrmDriver, [{ Name: 'postgres-dialect-test', Driver: 'orm-driver-postgres' } as any]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('registers its own dialect classes', () => {
    for (const abstraction of ['IdentifierQuoter', 'OnDuplicateQueryCompiler', 'InsertQueryCompiler', 'ColumnQueryCompiler', 'AlterColumnQueryCompiler', 'LimitQueryCompiler', 'CreateDatabaseCompiler', 'DropDatabaseCompiler', 'TableExistsCompiler', 'ServerResponseMapper', 'DefaultValueBuilder']) {
      expect(driver.Container.hasRegistered(abstraction), `${abstraction} must be registered by the postgres driver itself`).to.eq(true);
    }
  });

  /**
   * MySQL's `CREATE EVENT`, trigger-based table history and `CREATE TABLE ... LIKE` have
   * no postgres implementation here. They must stay UNREGISTERED so the failure is a DI
   * error naming the abstraction — not MySQL syntax reaching the server.
   */
  it('leaves unsupported dialect features unregistered', () => {
    for (const abstraction of ['EventQueryCompiler', 'DropEventQueryCompiler', 'TableHistoryQueryCompiler', 'TableCloneQueryCompiler']) {
      expect(driver.Container.hasRegistered(abstraction), `${abstraction} must NOT be registered - postgres has no implementation for it`).to.eq(false);
    }
  });

  it('quotes with double quotes, doubling embedded quotes', () => {
    const quoter = driver.Container.resolve<IdentifierQuoter>(IdentifierQuoter);

    expect(quoter.quote('Role')).to.eq('"Role"');
    expect(quoter.quote('we"ird')).to.eq('"we""ird"');
    expect(quoter.quoteQualified('public.users')).to.eq('"public"."users"');
  });

  it('reports RETURNING support and no events', () => {
    expect(driver.supportedFeatures()).to.deep.eq({ events: false, insertReturning: true, insertIdIsFirstOfBatch: false });
  });

  describe('positional parameters', () => {
    it('rewrites every ? into $1..$n in order', () => {
      expect(toPositionalParameters('SELECT * FROM "users" WHERE "id" = ? AND "name" LIKE ? LIMIT ?')).to.eq('SELECT * FROM "users" WHERE "id" = $1 AND "name" LIKE $2 LIMIT $3');
    });

    it('leaves a statement without placeholders untouched', () => {
      expect(toPositionalParameters('SELECT 1')).to.eq('SELECT 1');
    });
  });

  describe('server response mapper', () => {
    const mapper = new PostgresServerResponseMapper();

    it('reads a RETURNING key out of upsert rows', () => {
      const response = mapper.read([{ Id: 7 }], ['Id']);

      expect(response.LastInsertId).to.eq(7);
      expect(response.RowsAffected).to.eq(1);
      expect(response.Returning).to.deep.eq([{ Id: 7 }]);
    });

    it('does not invent an identity for a non-numeric key', () => {
      const response = mapper.read([{ Id: 'a-uuid' }], ['Id']);

      expect(response.LastInsertId).to.eq(0);
    });

    it('passes a normalized insert packet through, rows intact', () => {
      const response = mapper.read({ RowsAffected: 2, LastInsertId: 0, Returning: [{ Id: 1 }, { Id: 2 }] }, ['Id']);

      expect(response.RowsAffected).to.eq(2);
      expect(response.Returning).to.have.lengthOf(2);
    });
  });
});
