import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { ServerResponseMapper } from '@spinajs/orm';

import { MsSqlOrmDriver, MsSqlServerResponseMapper } from '../src/index.js';

describe('mssql insert response mapper', function () {
  this.timeout(15000);

  afterEach(() => {
    DI.clearCache();
  });

  it('is registered, so a model insert can read its result', async () => {
    const driver = await DI.resolve(MsSqlOrmDriver, [{ Name: 'mssql-mapper', Driver: 'orm-driver-mssql' } as any]);
    const mapper = driver.Container.resolve(ServerResponseMapper);

    expect(mapper).to.be.instanceOf(MsSqlServerResponseMapper);
    expect(mapper.read({ RowsAffected: 1, LastInsertId: 7, Returning: [] })).to.deep.eq({ RowsAffected: 1, LastInsertId: 7, Returning: [] });
    expect(mapper.read(undefined)).to.deep.eq({ RowsAffected: 0, LastInsertId: 0, Returning: [] });
  });
});
