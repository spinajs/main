import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { sqlDialectOf } from '@spinajs/orm';
import { POSTGRES_SQL_DIALECT, PostgresOrmDriver, toDriverStatement } from '../src/index.js';

describe('postgres SQL dialect profile', function () {
  this.timeout(15000);

  afterEach(() => DI.clearCache());

  it('is declared on the driver class', () => {
    expect(sqlDialectOf(PostgresOrmDriver)).to.equal(POSTGRES_SQL_DIALECT);
  });

  it('agrees with the response schema types of the driver', async () => {
    const driver = await DI.resolve(PostgresOrmDriver, [{ Name: 'pg-profile-test', Driver: 'orm-driver-postgres' } as any]);
    for (const family of ['bigint', 'decimal'] as const) {
      expect(POSTGRES_SQL_DIALECT.families[family], family).to.equal((driver.ResponseSchemaTypes[family] as { type: string }).type);
    }
  });

  it('sends ? as $n and keeps the jsonb operators, as the dollar style says', () => {
    expect(POSTGRES_SQL_DIALECT.placeholders).to.equal('dollar');
    expect(toDriverStatement('SELECT a FROM t WHERE a = ? AND b ?| ?', [1, 2])).to.equal('SELECT a FROM t WHERE a = $1 AND b ?| $2');
  });
});
