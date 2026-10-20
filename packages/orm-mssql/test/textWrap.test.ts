/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { ICompilerOutput, Wrapper } from '@spinajs/orm';
import { MsSqlOrmDriver } from '../src/index.js';

function compiled(query: { toDB(): ICompilerOutput | ICompilerOutput[] }): ICompilerOutput {
  return query.toDB() as ICompilerOutput;
}

describe('mssql Wrapper.Text', function () {
  this.timeout(15000);

  let driver: MsSqlOrmDriver;

  beforeEach(async () => {
    driver = await DI.resolve(MsSqlOrmDriver, [{ Name: 'mssql-text-test', Driver: 'orm-driver-mssql' } as any]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('casts to NVARCHAR(4000) in where() and whereIn(), a long list through OPENJSON', () => {
    expect(compiled(driver.select().from('t', 'i').whereIn(Wrapper.Text('Id'), ['1', '2'])).expression).to.contain('CAST([i].[Id] AS NVARCHAR(4000)) IN (?,?)');
    expect(compiled(driver.select().from('t').where(Wrapper.Text('Id'), '=', '1')).expression).to.contain('CAST([Id] AS NVARCHAR(4000)) = ?');
    const long = Array.from({ length: 201 }, (_, i) => `v${i}`);
    expect(compiled(driver.select().from('t').whereIn(Wrapper.Text('Id'), long)).expression).to.contain('CAST([Id] AS NVARCHAR(4000)) IN (SELECT [value] FROM OPENJSON(?))');
  });
});
