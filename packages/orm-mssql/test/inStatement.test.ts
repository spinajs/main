/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { ICompilerOutput } from '@spinajs/orm';
import { MsSqlOrmDriver } from '../src/index.js';

const list = (count: number) => Array.from({ length: count }, (_, i) => i);

function compiled(query: { toDB(): ICompilerOutput | ICompilerOutput[] }): ICompilerOutput {
  return query.toDB() as ICompilerOutput;
}

describe('mssql whereIn', function () {
  this.timeout(15000);

  let driver: MsSqlOrmDriver;

  beforeEach(async () => {
    driver = await DI.resolve(MsSqlOrmDriver, [{ Name: 'mssql-in-test', Driver: 'orm-driver-mssql' } as any]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('binds a list longer than 200 as one JSON parameter read with OPENJSON', () => {
    const result = compiled(driver.select().from('t').whereIn('id', list(201)));

    expect(result.expression).to.contain('[id] IN (SELECT [value] FROM OPENJSON(?))');
    expect(result.bindings).to.deep.eq([JSON.stringify(list(201))]);
  });

  it('uses NOT IN for whereNotIn', () => {
    expect(compiled(driver.select().from('t').whereNotIn('id', list(201))).expression).to.contain('[id] NOT IN (SELECT [value] FROM OPENJSON(?))');
  });

  it('keeps a list of 200 expanded', () => {
    const result = compiled(driver.select().from('t').whereIn('id', list(200)));

    expect(result.expression).to.contain('[id] IN (?,?,');
    expect(result.bindings).to.have.length(200);
  });

  it('compiles an empty list and where(true / false) to comparisons T-SQL accepts', () => {
    expect(compiled(driver.select().from('t').whereIn('id', [])).expression).to.contain('WHERE 1 = 0');
    expect(compiled(driver.select().from('t').where(false)).expression).to.contain('WHERE 1 = 0');
    expect(compiled(driver.select().from('t').where(true)).expression).to.contain('WHERE 1 = 1');
  });
});
