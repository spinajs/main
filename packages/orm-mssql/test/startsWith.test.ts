/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { ICompilerOutput, StartsWithStatement } from '@spinajs/orm';
import { MsSqlOrmDriver } from '../src/index.js';
import { MsSqlStartsWithStatement } from '../src/statements.js';

function compiled(query: { toDB(): ICompilerOutput | ICompilerOutput[] }): ICompilerOutput {
  return query.toDB() as ICompilerOutput;
}

describe('mssql whereStartsWith', function () {
  this.timeout(15000);

  let driver: MsSqlOrmDriver;

  beforeEach(async () => {
    driver = await DI.resolve(MsSqlOrmDriver, [{ Name: 'mssql-starts-test', Driver: 'orm-driver-mssql' } as any]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('uses the mssql implementation', () => {
    expect(driver.Container.resolve<StartsWithStatement>(StartsWithStatement, ['path', 'a/', undefined])).to.be.instanceOf(MsSqlStartsWithStatement);
  });

  it('escapes [ as well as the LIKE wildcards', () => {
    const result = compiled(driver.select().from('t').whereStartsWith('path', 'docs[1]_%/'));

    expect(result.expression).to.contain("[path] LIKE ? ESCAPE '~'");
    expect(result.bindings).to.deep.eq(['docs~[1]~_~%/%']);
  });

  it('keeps the bracket escape when the query is cloned', () => {
    expect(compiled(driver.select().from('t').whereStartsWith('path', 'docs[1]/').clone()).bindings).to.deep.eq(['docs~[1]/%']);
  });
});
