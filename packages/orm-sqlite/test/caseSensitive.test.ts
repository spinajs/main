import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { ICompilerOutput, Orm, TableQueryBuilder } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

describe('sqlite case-sensitive columns', function () {
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
    expect(create((t) => t.string('path', 512).notNull().caseSensitive())).to.equal(create((t) => t.string('path', 512).notNull()));
  });

  it('keeps case variants of a key apart', async () => {
    await driver()
      .schema()
      .createTable('case_key', (table) => {
        table.string('fs', 64).notNull().primaryKey().caseSensitive();
        table.string('path', 512).notNull().primaryKey().caseSensitive();
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
