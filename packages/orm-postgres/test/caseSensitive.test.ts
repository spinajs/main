import 'mocha';
import { expect } from 'chai';
// Registers the concrete logger; Orm.resolve() logs through it.
import '@spinajs/log';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { ICompilerOutput, Orm, SchemaQueryBuilder, TableQueryBuilder } from '@spinajs/orm';
import { ConnectionConf, FakePostgresDriver } from './fixture.js';

describe('postgres case-sensitive columns', function () {
  this.timeout(15000);

  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakePostgresDriver).as('postgres');
    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  function create(cb: (table: TableQueryBuilder) => void): string {
    const connection = DI.get(Orm)!.Connections.get('postgres')!;
    return (connection.Container.resolve(SchemaQueryBuilder, [connection]).createTable('t', cb).toDB() as unknown as ICompilerOutput[])[0].expression as string;
  }

  it('declares the C collation', () => {
    expect(create((t) => t.string('path', 512).notNull().caseSensitive())).to.contain('"path" VARCHAR(512) COLLATE "C" NOT NULL');
  });

  it('compiles what collation(C) compiles', () => {
    expect(create((t) => t.string('path', 512).notNull().primaryKey().caseSensitive())).to.equal(create((t) => t.string('path', 512).notNull().primaryKey().collation('C')));
  });

  it('keeps an explicit collation', () => {
    expect(create((t) => t.string('a').collation('und-x-icu').caseSensitive())).to.contain('"a" VARCHAR(255) COLLATE "und-x-icu"');
  });
});
