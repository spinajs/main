import 'mocha';
import * as chai from 'chai';
import { RawQuery } from '@spinajs/orm';

import { columnDefault } from '../src/column-default.js';

const expect = chai.expect;

describe('mssql column defaults', () => {
  it('reads a literal default as the value of its column type', () => {
    const cases: Array<[string, string, unknown]> = [
      ['((0))', 'int', 0],
      ['((-1))', 'smallint', -1],
      ['((1.5))', 'decimal', 1.5],
      ['((2.5E3))', 'float', 2500],
      ['((5))', 'bigint', '5'],
      ['((1))', 'bit', true],
      ['((0))', 'bit', false],
      ["('a')", 'varchar', 'a'],
      ["(N'it''s')", 'nvarchar', "it's"],
      ["('(x)')", 'nchar', '(x)'],
      ['((5))', 'nvarchar', '5'],
      ['(NULL)', 'nvarchar', null],
    ];

    for (const [text, type, value] of cases) {
      expect(columnDefault(text, type), `${text} ${type}`).to.deep.eq(value);
    }
  });

  it('leaves an expression, and a literal of a type it does not read, to the server', () => {
    for (const [text, type] of [
      ['(getdate())', 'datetime2'],
      ['(newid())', 'uniqueidentifier'],
      ['(NEXT VALUE FOR [dbo].[seq])', 'bigint'],
      ["(CONCAT(N'k-',(1)))", 'nvarchar'],
      ["('2020-01-01')", 'date'],
      ["('a')", 'int'],
      ['((1))', 'datetime'],
    ]) {
      const value = columnDefault(text, type);
      expect(value, `${text} ${type}`).to.be.instanceOf(RawQuery);
      expect((value as RawQuery).Query).to.eq(text);
    }
  });

  it('keeps a column without a default at null', () => {
    expect(columnDefault(null, 'int')).to.eq(null);
    expect(columnDefault(undefined, 'int')).to.eq(null);
  });
});
