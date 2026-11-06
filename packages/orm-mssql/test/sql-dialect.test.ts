import 'mocha';
import { expect } from 'chai';
import { familiesOf, sqlDialectOf } from '@spinajs/orm';
import { MSSQL_SQL_DIALECT, MsSqlOrmDriver, toNamedParameters } from '../src/index.js';

describe('mssql SQL dialect profile', () => {
  it('is declared on the driver class', () => {
    expect(sqlDialectOf(MsSqlOrmDriver)).to.equal(MSSQL_SQL_DIALECT);
  });

  it('sends ? as @p0.., as the at-p0 style says', () => {
    expect(MSSQL_SQL_DIALECT.placeholders).to.equal('at-p0');
    expect(toNamedParameters('SELECT a FROM t WHERE a = ? AND b = ?', 2)).to.equal('SELECT a FROM t WHERE a = @p0 AND b = @p1');
  });

  it('maps the native types tableInfo() reports to column families', () => {
    expect(familiesOf('nvarchar', MSSQL_SQL_DIALECT)).to.deep.equal(['text', 'enum', 'json']);
  });

  it('declares how migrate-diff compares names and text lengths', () => {
    expect(MSSQL_SQL_DIALECT.caseInsensitiveIdentifiers).to.equal(true);
    expect(MSSQL_SQL_DIALECT.unboundedText).to.equal(undefined);
  });
});
