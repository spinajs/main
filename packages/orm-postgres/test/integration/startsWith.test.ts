import 'mocha';
import { expect } from 'chai';
import { bootPostgres, PgTestDb, requirePostgres } from './support.js';

const PATHS = ['Docs/a', 'docs/b', 'a_b/x', 'axb/y', '100%/z', '1000/q', 'docs[1]/a', 'docs1/b', 'q*/1', 'qq/2', 'q?/3', 'qx/4', '~t/c', 'xt/d', 'b\\s/e', 'bxs/f'];

const CASES: [string, string[]][] = [
  ['docs/', ['docs/b']],
  ['Docs/', ['Docs/a']],
  ['a_b/', ['a_b/x']],
  ['100%/', ['100%/z']],
  ['docs[1]/', ['docs[1]/a']],
  ['q*/', ['q*/1']],
  ['q?/', ['q?/3']],
  ['~t/', ['~t/c']],
  ['b\\s/', ['b\\s/e']],
  ['', [...PATHS].sort()],
];

describe('postgres whereStartsWith (integration)', function () {
  this.timeout(60000);

  let pgdb: PgTestDb | undefined;

  before(async function () {
    await requirePostgres(this);
    pgdb = await bootPostgres('starts_with');
    await pgdb.driver.schema().createTable('pg_starts', (table) => {
      table.int('Id').primaryKey();
      table.string('Path', 255);
    });
    await pgdb.driver
      .insert()
      .into('pg_starts')
      .values([...PATHS.map((Path, Id) => ({ Id, Path })), { Id: 99, Path: null }]);
  });

  after(async () => {
    await pgdb?.dispose();
  });

  for (const [prefix, expected] of CASES) {
    it(`matches ${JSON.stringify(prefix)} literally and case-sensitively`, async () => {
      const rows = (await pgdb!.driver.select().select('Path').from('pg_starts').whereStartsWith('Path', prefix).asRaw()) as { Path: string }[];

      expect(rows.map((r) => r.Path).sort()).to.deep.eq(expected);
    });
  }
});
