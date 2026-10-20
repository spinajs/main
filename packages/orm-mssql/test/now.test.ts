import 'mocha';
import { expect } from 'chai';
import '@spinajs/log';
import { DI } from '@spinajs/di';
import { ICompilerOutput } from '@spinajs/orm';

import { MsSqlOrmDriver } from '../src/index.js';

describe('mssql database now', function () {
  this.timeout(15000);

  let driver: MsSqlOrmDriver;

  beforeEach(async () => {
    driver = await DI.resolve(MsSqlOrmDriver, [{ Name: 'mssql-now-test', Driver: 'orm-driver-mssql' } as any]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('is SYSDATETIMEOFFSET(), usable as a where value', () => {
    const out = driver.select().from('t').where('At', '<=', driver.now()).toDB() as ICompilerOutput;

    expect(driver.now().Query).to.eq('SYSDATETIMEOFFSET()');
    expect(out.expression).to.contain('[At] <= SYSDATETIMEOFFSET()');
    expect(out.bindings).to.deep.eq([]);
  });
});
