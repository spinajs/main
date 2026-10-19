import 'mocha';
import { expect } from 'chai';
import * as sinon from 'sinon';
// Registers the concrete logger, as every suite in this package does.
import '@spinajs/log';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm, SelectQueryBuilder } from '@spinajs/orm';
import { ConnectionConf, FakeSqliteDriver } from './fixture.js';
import { Model1 } from './Models/Model1.js';

function connection(): FakeSqliteDriver {
  return DI.get(Orm)!.Connections.get('sqlite') as FakeSqliteDriver;
}

function sqb() {
  return connection().Container.resolve(SelectQueryBuilder, [connection()]);
}

describe('count results', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    await DI.resolve(Orm);
  });

  afterEach(() => {
    sinon.restore();
    DI.clearCache();
  });

  it('selectCount turns a bigint count string into a number', async () => {
    sinon.stub(connection(), 'executeOnDb').resolves([{ count: '7' }]);

    expect(await sqb().from('users').selectCount()).to.equal(7);
  });

  it('selectCount reads a custom alias', async () => {
    sinon.stub(connection(), 'executeOnDb').resolves([{ total: '3' }]);

    expect(await sqb().from('users').selectCount('*', 'total')).to.equal(3);
  });

  it('selectCount resolves 0 when no row comes back', async () => {
    sinon.stub(connection(), 'executeOnDb').resolves([]);

    expect(await sqb().from('users').selectCount()).to.equal(0);
  });

  it('Model.count turns a bigint count string into a number', async () => {
    sinon.stub(connection(), 'executeOnDb').resolves([{ count: '12' }]);

    expect(await Model1.count()).to.equal(12);
  });
});
