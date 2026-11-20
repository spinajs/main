import * as chai from 'chai';
import 'mocha';
import { normalizeSqlType } from '../src/schema.js';

const expect = chai.expect;

describe('normalizeSqlType', () => {
  const spellings: [string, string][] = [
    ['INTEGER', 'integer'],
    ['int', 'int'],
    ['int(11)', 'int'],
    ['int(11) unsigned', 'int'],
    ['int(11) unsigned zerofill', 'int'],
    ['INTEGER UNSIGNED', 'integer'],
    ['BIGINT SIGNED', 'bigint'],
    ['BIGINT(20)', 'bigint'],
    ['UNSIGNED BIG INT', 'big int'],
    ['DECIMAL(10,2)', 'decimal'],
    ['decimal(10, 2) unsigned', 'decimal'],
    ['DOUBLE PRECISION', 'double precision'],
    ['  double   precision ', 'double precision'],
    ['REAL', 'real'],
    ['VARCHAR(64)', 'varchar'],
    ['dateTime', 'datetime'],
    ['int8', 'int8'],
    ['', ''],
  ];

  for (const [declared, normalized] of spellings) {
    it(`reads '${declared}' as '${normalized}'`, () => {
      expect(normalizeSqlType(declared)).to.eq(normalized);
    });
  }
});
