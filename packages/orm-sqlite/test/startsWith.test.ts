import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { ICompilerOutput, Orm } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

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

describe('sqlite whereStartsWith', function () {
  this.timeout(30000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await driver()
      .schema()
      .createTable('starts', (table) => {
        table.int('Id').primaryKey();
        table.string('Path', 255);
      });
    await driver()
      .insert()
      .into('starts')
      .values([...PATHS.map((Path, Id) => ({ Id, Path })), { Id: 99, Path: null }]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('compiles to GLOB with the GLOB wildcards of the prefix bracketed', () => {
    const result = driver().select().from('starts').whereStartsWith('Path', 'docs[1]*?/').toDB() as ICompilerOutput;

    expect(result.expression).to.contain('`Path` GLOB ?');
    expect(result.bindings).to.deep.eq(['docs[[]1][*][?]/*']);
  });

  for (const [prefix, expected] of CASES) {
    it(`matches ${JSON.stringify(prefix)} literally and case-sensitively`, async () => {
      const rows = (await driver().select().select('Path').from('starts').whereStartsWith('Path', prefix).asRaw()) as { Path: string }[];

      expect(rows.map((r) => r.Path).sort()).to.deep.eq(expected);
    });
  }
});
