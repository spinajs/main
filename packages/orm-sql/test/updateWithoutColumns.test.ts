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

describe('update without columns', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('refuses to compile update({}) instead of an empty SET', () => {
    expect(() => connection().update().in('users').update({}).where('Id', 1).toDB()).to.throw(InvalidArgument, 'update of users sets no column');
  });

  it('refuses to compile an update that was never given values', () => {
    expect(() => connection().update().in('users').where('Id', 1).toDB()).to.throw(InvalidArgument, 'update of users sets no column');
  });

  it('still names the missing where clause first', () => {
    expect(() => connection().update().in('users').update({}).toDB()).to.throw(InvalidArgument, 'update of users has no where clause');
  });

  it('compiles one column as before', () => {
    const result = connection().update().in('users').update({ Name: 'x' }).where('Id', 1).toDB();

    expect(result.expression).to.eq('UPDATE `users` SET `Name` = ? WHERE `Id` = ?');
    expect(result.bindings).to.deep.eq(['x', 1]);
  });

  it('compiles several columns and an increment as before', () => {
    const result = connection().update().in('users').update({ Name: 'x', Age: 2 }).increment('Hits').where('Id', 1).toDB();

    expect(result.expression).to.eq('UPDATE `users` SET `Name` = ?,`Age` = ?,`Hits` = `Hits` + ? WHERE `Id` = ?');
    expect(result.bindings).to.deep.eq(['x', 2, 1, 1]);
  });

  it('compiles an update that only increments as before', () => {
    const result = connection().update().in('users').update({}).increment('Hits').where('Id', 1).toDB();

    expect(result.expression).to.eq('UPDATE `users` SET `Hits` = `Hits` + ? WHERE `Id` = ?');
    expect(result.bindings).to.deep.eq([1, 1]);
  });
});
