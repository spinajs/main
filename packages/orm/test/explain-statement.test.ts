import 'mocha';
import { expect } from 'chai';
import { isExplainable } from '../src/explain/statement.js';

describe('isExplainable', () => {
  const cases: Array<[string, boolean]> = [
    ['SELECT * FROM t WHERE a = ?', true],
    [' with x as (select 1) select * from x', true],
    ["WITH x AS (SELECT 'update') SELECT * FROM x", true],
    ['SELECT * FROM t FOR UPDATE', true],
    ['SELECT 1;', true],
    ['SELECT 1; DROP TABLE t', false],
    ["SELECT 'a;b' FROM t", false],
    ["SELECT $$it's$$; DELETE FROM t WHERE n = $$it's$$", false],
    ["SELECT 1 -- it's\n; DELETE FROM t -- it's", false],
    ["SELECT E'\\''; DELETE FROM t; --'", false],
    ["SELECT 1 /* it's */; DELETE FROM t /* it's */", false],
    ["SELECT 1 # it's\n; DELETE FROM t # it's", false],
    ['SELECT $$x$$', false],
    ['SELECT 1 -- note', false],
    ['SELECT 1 /* note */', false],
    ['SELECT 1 # note', false],
    ["SELECT * FROM t WHERE a LIKE 'x\\_%'", false],
    ['INSERT INTO t VALUES (?)', false],
    ['UPDATE t SET a = 1', false],
    ['WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', false],
    ['PRAGMA table_info(t)', false],
  ];

  for (const [sql, expected] of cases) {
    it(`${expected ? 'accepts' : 'rejects'} ${JSON.stringify(sql)}`, () => {
      expect(isExplainable(sql)).to.equal(expected);
    });
  }
});
