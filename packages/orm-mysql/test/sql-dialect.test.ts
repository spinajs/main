import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { familiesOf, sqlDialectOf } from '@spinajs/orm';
import { MYSQL_SQL_DIALECT, MySqlOrmDriver, MySqlSSHOrmDriver } from '../src/index.js';

describe('mysql SQL dialect profile', function () {
  this.timeout(15000);

  afterEach(() => DI.clearCache());

  it('is declared on both driver classes', () => {
    expect(sqlDialectOf(MySqlOrmDriver)).to.equal(MYSQL_SQL_DIALECT);
    expect(sqlDialectOf(MySqlSSHOrmDriver)).to.equal(MYSQL_SQL_DIALECT);
  });

  it('agrees with the response schema types of the driver: DECIMAL is a string, BIGINT is not listed', async () => {
    const driver = await DI.resolve(MySqlOrmDriver, [{ Name: 'mysql-profile-test', Driver: 'orm-driver-mysql' } as any]);
    expect(MYSQL_SQL_DIALECT.families.decimal).to.equal((driver.ResponseSchemaTypes.decimal as { type: string }).type);
    expect(driver.ResponseSchemaTypes).to.not.have.property('bigint');
    expect(MYSQL_SQL_DIALECT.families.bigint).to.equal('number');
  });

  it('maps the native types tableInfo() reports to column families', () => {
    expect(familiesOf('tinyint', MYSQL_SQL_DIALECT)).to.deep.equal(['integer', 'boolean']);
    // packages store uuids as string(name, 36)
    expect(familiesOf('varchar', MYSQL_SQL_DIALECT)).to.include('uuid');
    expect(familiesOf('char', MYSQL_SQL_DIALECT)).to.include('uuid');
  });

  it('declares how migrate-diff compares names and text lengths', () => {
    expect(MYSQL_SQL_DIALECT.caseInsensitiveIdentifiers).to.equal(true);
    expect(MYSQL_SQL_DIALECT.unboundedText).to.equal(undefined);
  });
});
