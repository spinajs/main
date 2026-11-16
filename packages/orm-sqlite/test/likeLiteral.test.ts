import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { LikeLiteral, Orm } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

const NAMES = ['100%', '1000', 'a_b', 'axb', 'b\\s', 'bxs', '~t', 'xt', 'docs[1]', 'docs1', 'Plain'];

const CASES: [LikeLiteral, string[]][] = [
  [LikeLiteral.contains('%'), ['100%']],
  [LikeLiteral.contains('_'), ['a_b']],
  [LikeLiteral.contains('\\'), ['b\\s']],
  [LikeLiteral.contains('~'), ['~t']],
  [LikeLiteral.contains('[1]'), ['docs[1]']],
  [LikeLiteral.contains('plain'), ['Plain']],
  [LikeLiteral.startsWith('a_'), ['a_b']],
  [LikeLiteral.startsWith('%'), []],
  [LikeLiteral.endsWith('0%'), ['100%']],
  [LikeLiteral.endsWith('_b'), ['a_b']],
];

describe('sqlite LikeLiteral', function () {
  this.timeout(30000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await driver()
      .schema()
      .createTable('like_literal', (table) => {
        table.int('Id').primaryKey();
        table.string('Name', 255);
      });
    await driver()
      .insert()
      .into('like_literal')
      .values([...NAMES.map((Name, Id) => ({ Id, Name })), { Id: 99, Name: null }]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  for (const [literal, expected] of CASES) {
    it(`${literal.Match} ${JSON.stringify(literal.Text)} matches literally, case as LIKE does`, async () => {
      const rows = await driver().select().select('Name').from('like_literal').where('Name', 'like', literal).asRaw<{ Name: string }[]>();

      expect(rows.map((r) => r.Name).sort()).to.deep.eq(expected);
    });
  }
});
