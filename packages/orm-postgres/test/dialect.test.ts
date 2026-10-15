import 'mocha';
import { expect } from 'chai';

import { DI } from '@spinajs/di';
import { MethodNotImplemented } from '@spinajs/exceptions';
import { IdentifierQuoter, RawQuery, SchemaQueryBuilder } from '@spinajs/orm';

import { parseColumnDefault, PostgresOrmDriver, PostgresServerResponseMapper, toPositionalParameters } from '../src/index.js';

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
   * Trigger-based table history and `CREATE TABLE ... LIKE` have no postgres implementation
   * here. They must stay UNREGISTERED so the failure is a DI error naming the abstraction —
   * not MySQL syntax reaching the server.
   */
  it('leaves unsupported dialect features unregistered', () => {
    for (const abstraction of ['TableHistoryQueryCompiler', 'TableCloneQueryCompiler']) {
      expect(driver.Container.hasRegistered(abstraction), `${abstraction} must NOT be registered - postgres has no implementation for it`).to.eq(false);
    }
  });

  it('refuses scheduled events, which postgres does not have natively', () => {
    const schema = driver.Container.resolve(SchemaQueryBuilder, [driver]);

    expect(driver.supportedFeatures().events).to.eq(false);
    expect(() => schema.createEvent('e', (event) => event.every(1, 'DAY').do(new RawQuery('SELECT 1'))).toDB()).to.throw(MethodNotImplemented, 'orm-driver-postgres has no native scheduled events');
    expect(() => schema.dropEvent('e').toDB()).to.throw(MethodNotImplemented, 'orm-driver-postgres has no native scheduled events');
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

describe('postgres column defaults (information_schema.columns.column_default)', () => {
  it('reads literal defaults as values of the column type', () => {
    expect(parseColumnDefault(`'abc'::character varying`, 'varchar')).to.eq('abc');
    expect(parseColumnDefault(`'it''s'::text`, 'text')).to.eq("it's");
    expect(parseColumnDefault('0', 'int4')).to.eq(0);
    expect(parseColumnDefault(`'-1'::integer`, 'int4')).to.eq(-1);
    expect(parseColumnDefault('1.5', 'float8')).to.eq(1.5);
    expect(parseColumnDefault('12.50', 'numeric')).to.eq('12.50');
    expect(parseColumnDefault(`'9007199254740993'::bigint`, 'int8')).to.eq('9007199254740993');
    expect(parseColumnDefault('true', 'bool')).to.eq(true);
    expect(parseColumnDefault('false', 'bool')).to.eq(false);
  });

  it('reads no default and a NULL default as null', () => {
    expect(parseColumnDefault(null, 'varchar')).to.eq(null);
    expect(parseColumnDefault('NULL::character varying', 'varchar')).to.eq(null);
  });

  it('keeps an expression default as raw SQL, so the server evaluates it', () => {
    for (const [raw, type] of [
      ['gen_random_uuid()', 'uuid'],
      ['CURRENT_TIMESTAMP', 'timestamptz'],
      [`nextval('t_id_seq'::regclass)`, 'int4'],
      [`'{}'::jsonb`, 'jsonb'],
    ]) {
      const parsed = parseColumnDefault(raw, type);
      expect(parsed, raw).to.be.instanceOf(RawQuery);
      expect((parsed as RawQuery).Query).to.eq(raw);
    }
  });
});
