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
    expect(familiesOf('nvarchar', MSSQL_SQL_DIALECT)).to.deep.equal(['text', 'enum', 'json', 'uuid']);
    expect(familiesOf('varchar', MSSQL_SQL_DIALECT)).to.include('uuid');
    expect(familiesOf('char', MSSQL_SQL_DIALECT)).to.deep.equal(['text', 'enum', 'uuid']);
    expect(familiesOf('nchar', MSSQL_SQL_DIALECT)).to.deep.equal(familiesOf('nvarchar', MSSQL_SQL_DIALECT));
  });

  it('declares how migrate-diff compares names and text lengths', () => {
    expect(MSSQL_SQL_DIALECT.caseInsensitiveIdentifiers).to.equal(true);
    expect(MSSQL_SQL_DIALECT.unboundedText).to.equal(undefined);
  });

  it('flags no primary key column Unique under the manifest source, as tableInfo() does not', () => {
    expect(MSSQL_SQL_DIALECT.uniquePrimaryKey).to.equal('none');
  });
});
