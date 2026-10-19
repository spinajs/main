/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { ICompilerOutput, SchemaQueryBuilder, TableQueryBuilder } from '@spinajs/orm';
import { MsSqlOrmDriver } from '../src/index.js';

describe('mssql case-sensitive columns', function () {
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
    expect(create((t) => t.string('path', 512).notNull().caseSensitive())).to.contain('[path] NVARCHAR(512) COLLATE Latin1_General_100_BIN2 NOT NULL');
  });

  it('leaves a string column without caseSensitive() VARCHAR on the database collation', () => {
    const plain = create((t) => t.string('c'));
    expect(plain).to.contain('[c] VARCHAR(255)');
    expect(plain).to.not.contain('NVARCHAR');
    expect(plain).to.not.contain('COLLATE');
  });

  it('declares no character set for a case-sensitive column', () => {
    expect(create((t) => t.string('c').caseSensitive())).to.not.contain('CHARACTER SET');
  });

  it('writes an explicit collation unquoted and refuses a name that is not one', () => {
    expect(create((t) => t.string('a').collation('Latin1_General_CS_AS').caseSensitive())).to.contain('[a] NVARCHAR(255) COLLATE Latin1_General_CS_AS');
    expect(create((t) => t.string('b').collation('Latin1_General_CS_AS'))).to.contain('[b] VARCHAR(255) COLLATE Latin1_General_CS_AS');
    expect(() => create((t) => t.string('c').collation("x' --"))).to.throw(InvalidArgument, 'invalid collation name');
  });
});
