import { expect } from 'chai';
import { InvalidOperation } from '@spinajs/exceptions';
import { journalPositionSql } from '../src/index.js';
import { quoteFor, sqlDialect } from '../src/store/raw-sql.js';

describe('raw SQL dialects', () => {
  it('maps the supported drivers and refuses any other', () => {
    expect(sqlDialect('orm-driver-sqlite', 'x')).to.eq('sqlite');
    expect(sqlDialect('orm-driver-mysql-ssh', 'x')).to.eq('mysql');
    expect(sqlDialect('orm-driver-postgres', 'x')).to.eq('postgres');
    expect(() => sqlDialect('orm-driver-mssql', 'counter statements'))
      .to.throw(InvalidOperation)
      .with.property('message', "scheduler: no counter statements for driver 'orm-driver-mssql'");
    expect(() => journalPositionSql('orm-driver-mssql')).to.throw(InvalidOperation, /no journal position statements/);
  });

  it('quotes identifiers per dialect', () => {
    expect(quoteFor('mysql')('Count')).to.eq('`Count`');
    expect(quoteFor('postgres')('Count')).to.eq('"Count"');
    expect(quoteFor('sqlite')('Count')).to.eq('"Count"');
  });
});
