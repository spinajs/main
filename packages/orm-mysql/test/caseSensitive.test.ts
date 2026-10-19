/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { ICompilerOutput, SchemaQueryBuilder, TableQueryBuilder } from '@spinajs/orm';
import { MySqlOrmDriver } from '../src/index.js';

describe('mysql case-sensitive columns', function () {
  this.timeout(15000);

  let driver: MySqlOrmDriver;

  beforeEach(async () => {
    driver = await DI.resolve(MySqlOrmDriver, [{ Name: 'mysql-case-test', Driver: 'orm-driver-mysql' } as any]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  const create = (cb: (table: TableQueryBuilder) => void): string => (driver.Container.resolve(SchemaQueryBuilder, [driver]).createTable('t', cb).toDB() as unknown as ICompilerOutput[])[0].expression as string;

  it('declares utf8mb4 with its binary collation', () => {
    expect(create((t) => t.string('path', 512).notNull().caseSensitive())).to.contain("`path` VARCHAR(512) CHARACTER SET 'utf8mb4' COLLATE 'utf8mb4_bin' NOT NULL");
  });

  it('compiles what charset(utf8mb4) with collation(utf8mb4_bin) compiles', () => {
    expect(create((t) => t.string('path', 512).notNull().primaryKey().caseSensitive())).to.equal(create((t) => t.string('path', 512).notNull().primaryKey().charset('utf8mb4').collation('utf8mb4_bin')));
  });

  it('takes the binary collation of an explicit charset, and an explicit collation as given', () => {
    expect(create((t) => t.string('a').charset('latin1').caseSensitive())).to.contain("`a` VARCHAR(255) CHARACTER SET 'latin1' COLLATE 'latin1_bin'");
    const explicit = create((t) => t.string('b').collation('utf8mb4_0900_bin').caseSensitive());
    expect(explicit).to.contain("`b` VARCHAR(255) COLLATE 'utf8mb4_0900_bin'");
    expect(explicit).to.not.contain('CHARACTER SET');
  });

  it('leaves a column without caseSensitive() on the table default', () => {
    expect(create((t) => t.string('c'))).to.not.contain('COLLATE');
  });
});
