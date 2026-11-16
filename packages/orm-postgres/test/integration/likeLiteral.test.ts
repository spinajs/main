import 'mocha';
import { expect } from 'chai';
import { LikeLiteral } from '@spinajs/orm';
import { bootPostgres, PgTestDb, requirePostgres } from './support.js';

const NAMES = ['100%', '1000', 'a_b', 'axb', 'b\\s', 'bxs', '~t', 'xt', 'docs[1]', 'docs1', 'Plain'];

const CASES: [LikeLiteral, string[]][] = [
  [LikeLiteral.contains('%'), ['100%']],
  [LikeLiteral.contains('_'), ['a_b']],
  [LikeLiteral.contains('\\'), ['b\\s']],
  [LikeLiteral.contains('b\\s'), ['b\\s']],
  [LikeLiteral.contains('~'), ['~t']],
  [LikeLiteral.contains('[1]'), ['docs[1]']],
  [LikeLiteral.contains('plain'), []],
  [LikeLiteral.startsWith('a_'), ['a_b']],
  [LikeLiteral.endsWith('0%'), ['100%']],
];

describe('postgres LikeLiteral (integration)', function () {
  this.timeout(60000);

  let pgdb: PgTestDb | undefined;

  before(async function () {
    await requirePostgres(this);
    pgdb = await bootPostgres('like_literal');
    await pgdb.driver.schema().createTable('pg_like', (table) => {
      table.int('Id').primaryKey();
      table.string('Name', 255);
    });
    await pgdb.driver
      .insert()
      .into('pg_like')
      .values([...NAMES.map((Name, Id) => ({ Id, Name })), { Id: 99, Name: null }]);
  });

  after(async () => {
    await pgdb?.dispose();
  });

  for (const [literal, expected] of CASES) {
    it(`${literal.Match} ${JSON.stringify(literal.Text)} matches literally, case as LIKE does`, async () => {
      const rows = await pgdb!.driver.select().select('Name').from('pg_like').where('Name', 'like', literal).asRaw<{ Name: string }[]>();

      expect(rows.map((r) => r.Name).sort()).to.deep.eq(expected);
    });
  }
});
