import 'mocha';
import { expect } from 'chai';
// Registers the concrete logger, as every suite in this package does.
import '@spinajs/log';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument } from '@spinajs/exceptions';
import { Orm } from '@spinajs/orm';
import { ConnectionConf, FakeSqliteDriver } from './fixture.js';

function connection() {
  return DI.get(Orm)!.Connections.get('sqlite')!;
}

describe('update without where', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('refuses to compile an update without a where clause', () => {
    expect(() => connection().update().in('users').update({ Name: 'x' }).toDB()).to.throw(InvalidArgument, 'update of users has no where clause');
  });

  it('compiles where(true) for a deliberate update of every row', () => {
    expect(connection().update().in('users').update({ Name: 'x' }).where(true).toDB().expression).to.eq('UPDATE `users` SET `Name` = ? WHERE TRUE');
  });
});
