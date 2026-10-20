/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { InvalidArgument, NotSupported } from '@spinajs/exceptions';
import { ICompilerOutput, SchemaQueryBuilder, TableQueryBuilder } from '@spinajs/orm';
import { MsSqlOrmDriver } from '../src/index.js';

describe('mssql exact columns', function () {
  this.timeout(15000);

  let driver: MsSqlOrmDriver;

  beforeEach(async () => {
    driver = await DI.resolve(MsSqlOrmDriver, [{ Name: 'mssql-case-test', Driver: 'orm-driver-mssql' } as any]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  const create = (cb: (table: TableQueryBuilder) => void): string => (driver.Container.resolve(SchemaQueryBuilder, [driver]).createTable('t', cb).toDB() as unknown as ICompilerOutput[])[0].expression as string;

  it('declares an NVARCHAR column with Latin1_General_100_BIN2, unquoted', () => {
    expect(create((t) => t.string('path', 512).notNull().exact())).to.contain('[path] NVARCHAR(512) COLLATE Latin1_General_100_BIN2 NOT NULL');
  });

  it('leaves a string column without exact() VARCHAR on the database collation', () => {
    const plain = create((t) => t.string('c'));
    expect(plain).to.contain('[c] VARCHAR(255)');
    expect(plain).to.not.contain('NVARCHAR');
    expect(plain).to.not.contain('COLLATE');
  });

  it('declares no character set for a case-sensitive column', () => {
    expect(create((t) => t.string('c').exact())).to.not.contain('CHARACTER SET');
  });

  it('refuses charset(), which T-SQL has no column syntax for', () => {
    expect(() => create((t) => t.string('c').charset('utf8mb4'))).to.throw(NotSupported, 'use collation() instead');
  });

  it('refuses exact() on a column that is not a string, naming the column', () => {
    expect(() => create((t) => t.int('qty').exact())).to.throw(InvalidArgument, "'qty'");
  });

  it('writes an explicit collation unquoted and refuses a name that is not one', () => {
    expect(create((t) => t.string('a').collation('Latin1_General_CS_AS').exact())).to.contain('[a] NVARCHAR(255) COLLATE Latin1_General_CS_AS');
    expect(create((t) => t.string('b').collation('Latin1_General_CS_AS'))).to.contain('[b] VARCHAR(255) COLLATE Latin1_General_CS_AS');
    expect(() => create((t) => t.string('c').collation("x' --"))).to.throw(InvalidArgument, 'invalid collation name');
  });
});
