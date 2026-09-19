import 'mocha';
import { expect } from 'chai';

import { DI } from '@spinajs/di';
import { MethodNotImplemented } from '@spinajs/exceptions';
import { CreateViewQueryBuilder, ICompilerOutput, LiteralQuoter, RawQuery, SchemaQueryBuilder } from '@spinajs/orm';

import { MsSqlOrmDriver } from '../src/index.js';
import { MsSqlLiteralQuoter } from '../src/statements.js';

/** What actually reaches SQL Server: the driver strips backticks in executeOnDb. */
function sent(output: ICompilerOutput) {
  return (output.expression as string).replaceAll('`', '');
}

describe('mssql views', function () {
  this.timeout(15000);

  let driver: MsSqlOrmDriver;

  beforeEach(async () => {
    driver = await DI.resolve(MsSqlOrmDriver, [{ Name: 'mssql-view-test', Driver: 'orm-driver-mssql' } as any]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  const schema = () => driver.Container.resolve(SchemaQueryBuilder, [driver]);
  const view = (build: (view: CreateViewQueryBuilder) => void) => schema().createView('active_users', build);

  it('registers its own view compiler and literal quoter', () => {
    expect(driver.Container.hasRegistered('CreateViewCompiler')).to.eq(true);
    expect(driver.Container.resolve<LiteralQuoter>(LiteralQuoter)).to.be.instanceOf(MsSqlLiteralQuoter);
  });

  it('spells OR REPLACE as CREATE OR ALTER and has the plain check option', () => {
    const result = view((v) => v.orReplace().columns(['id', 'name']).checkOption().as(new RawQuery('SELECT id, name FROM users')));

    expect(sent(result.toDB())).to.eq('CREATE OR ALTER VIEW active_users ([id],[name]) AS SELECT id, name FROM users WITH CHECK OPTION');
  });

  it('throws for the clauses mssql does not have', () => {
    const raw = new RawQuery('SELECT 1');

    expect(() => view((v) => v.ifNotExists().as(raw)).toDB()).to.throw(MethodNotImplemented, 'mssql does not support IF NOT EXISTS');
    expect(() => view((v) => v.temporary().as(raw)).toDB()).to.throw(MethodNotImplemented, 'TEMPORARY');
    expect(() => view((v) => v.algorithm('MERGE').as(raw)).toDB()).to.throw(MethodNotImplemented, 'ALGORITHM');
    expect(() => view((v) => v.security('INVOKER').as(raw)).toDB()).to.throw(MethodNotImplemented, 'SQL SECURITY');
    expect(() => view((v) => v.checkOption('CASCADED').as(raw)).toDB()).to.throw(MethodNotImplemented, 'WITH CASCADED CHECK OPTION');
  });

  it('refuses a database prefix, which T-SQL forbids on CREATE VIEW', () => {
    expect(() => view((v) => v.database('other').as(new RawQuery('SELECT 1'))).toDB()).to.throw(MethodNotImplemented, 'database prefix');
  });

  it('writes unicode string literals and 1 / 0 booleans', () => {
    const quoter = driver.Container.resolve<LiteralQuoter>(LiteralQuoter);

    expect(quoter.quote(`it's`)).to.eq(`N'it''s'`);
    expect(quoter.quote(true)).to.eq('1');
  });

  it('inlines raw body bindings', () => {
    const result = view((v) => v.as(new RawQuery('SELECT * FROM users WHERE role = ? AND age > ?', ['admin', 18])));

    expect(sent(result.toDB())).to.eq(`CREATE VIEW active_users AS SELECT * FROM users WHERE role = N'admin' AND age > 18`);
  });

  it('drops a view', () => {
    expect(sent(schema().dropView('active_users').ifExists().toDB())).to.eq('DROP VIEW IF EXISTS active_users');
  });
});
