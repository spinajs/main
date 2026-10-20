import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { ICompilerOutput, Orm, TableQueryBuilder } from '@spinajs/orm';
import { expect } from 'chai';
import { InvalidArgument } from '@spinajs/exceptions';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

describe('sqlite exact columns', function () {
  this.timeout(30000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  const create = (cb: (table: TableQueryBuilder) => void): string => (driver().schema().createTable('t', cb).toDB() as unknown as ICompilerOutput[])[0].expression as string;

  it('declares no collation: BINARY, the default, is already exact', () => {
    expect(create((t) => t.string('path', 512).notNull().exact())).to.equal(create((t) => t.string('path', 512).notNull()));
  });

  it('refuses exact() on a column that is not a string, naming the column', () => {
    expect(() => create((t) => t.int('qty').exact())).to.throw(InvalidArgument, "'qty'");
  });

  it('keeps case variants of a key apart', async () => {
    await driver()
      .schema()
      .createTable('case_key', (table) => {
        table.string('fs', 64).notNull().primaryKey().exact();
        table.string('path', 512).notNull().primaryKey().exact();
      });
    await driver()
      .insert()
      .into('case_key')
      .values([
        { fs: 'u', path: 'Report.pdf' },
        { fs: 'u', path: 'report.pdf' },
      ]);

    expect(await driver().select().from('case_key').where({ path: 'report.pdf' }).asRaw()).to.deep.equal([{ fs: 'u', path: 'report.pdf' }]);
  });
});
