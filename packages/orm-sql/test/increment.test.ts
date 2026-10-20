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

describe('update increment', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('compiles col = col + ? after the set values, adding up calls on one column', () => {
    const query = connection().update().in('counter').update({ Name: 'x' }).increment('Hits').increment('Hits', 2).where('Id', 1);
    const result = query.toDB();

    expect(result.expression).to.eq('UPDATE `counter` SET `Name` = ?,`Hits` = `Hits` + ? WHERE `Id` = ?');
    expect(result.bindings).to.deep.eq(['x', 3, 1]);
  });

  it('keeps Value to the set values and exposes the increments apart', () => {
    const query = connection().update().in('counter').update({ Name: 'x' }).increment('Hits', 2);

    expect(query.Value).to.deep.eq({ Name: 'x' });
    expect([...query.Increments]).to.deep.eq([['Hits', 2]]);
  });

  it('compiles an update that only increments', () => {
    const result = connection().update().in('counter').increment('Hits', -1).where('Id', 1).toDB();

    expect(result.expression).to.eq('UPDATE `counter` SET `Hits` = `Hits` + ? WHERE `Id` = ?');
    expect(result.bindings).to.deep.eq([-1, 1]);
  });

  it('refuses a non-finite amount and an empty column', () => {
    expect(() => connection().update().in('counter').increment('Hits', Number.NaN)).to.throw(InvalidArgument);
    expect(() => connection().update().in('counter').increment('Hits', Number.POSITIVE_INFINITY)).to.throw(InvalidArgument);
    expect(() => connection().update().in('counter').increment(' ')).to.throw(InvalidArgument);
  });

  it('refuses a column that is both set and incremented', () => {
    expect(() => connection().update().in('counter').update({ Hits: 1 }).increment('Hits').where('Id', 1).toDB()).to.throw(InvalidArgument, 'both set and incremented');
  });
});
