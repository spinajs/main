import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { dbNowSql, defaultSqlDriver, quoteFor, sqlDialect, SqlDbTimeSource } from '../src/index.js';
import { bootDb } from './support/env.js';

describe('database time', () => {
  after(() => DI.dispose());

  it('has a query per supported driver', () => {
    expect(dbNowSql('orm-driver-sqlite')).to.contain('julianday');
    expect(dbNowSql('orm-driver-mysql')).to.contain('UTC_TIMESTAMP(3)').and.not.contain('NOW(');
    expect(dbNowSql('orm-driver-mysql-ssh')).to.contain('UTC_TIMESTAMP');
    expect(dbNowSql('orm-driver-postgres')).to.contain('clock_timestamp()');
    expect(() => dbNowSql('orm-driver-mssql')).to.throw(/no database time query/);
  });

  it('reads sqlite time in epoch milliseconds', async () => {
    await bootDb();
    const ms = await DI.resolve(SqlDbTimeSource).read();
    expect(Math.abs(ms - Date.now())).to.be.lessThan(5000);
  });

  it('finds the default connection', async () => {
    const driver = await bootDb();
    expect(await defaultSqlDriver()).to.eq(driver);
  });
});

describe('raw SQL dialects', () => {
  it('maps the supported drivers and refuses any other, naming the owner', () => {
    expect(sqlDialect('orm-driver-sqlite', 'x')).to.eq('sqlite');
    expect(sqlDialect('orm-driver-mysql-ssh', 'x')).to.eq('mysql');
    expect(sqlDialect('orm-driver-postgres', 'x')).to.eq('postgres');
    expect(() => sqlDialect('orm-driver-mssql', 'lease statements')).to.throw(InvalidOperation).with.property('message', "durable: no lease statements for driver 'orm-driver-mssql'");
    expect(() => sqlDialect('orm-driver-mssql', 'counter statements', 'scheduler')).to.throw("scheduler: no counter statements for driver 'orm-driver-mssql'");
  });

  it('quotes identifiers per dialect', () => {
    expect(quoteFor('mysql')('Count')).to.eq('`Count`');
    expect(quoteFor('postgres')('Count')).to.eq('"Count"');
    expect(quoteFor('sqlite')('Count')).to.eq('"Count"');
  });
});
