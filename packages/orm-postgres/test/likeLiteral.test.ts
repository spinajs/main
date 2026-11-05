import 'mocha';
import { expect } from 'chai';
// Registers the concrete logger; Orm.resolve() logs through it.
import '@spinajs/log';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { LikeLiteral, Orm, SelectQueryBuilder } from '@spinajs/orm';
import { ConnectionConf, FakePostgresDriver } from './fixture.js';

describe('postgres LikeLiteral', function () {
  this.timeout(15000);

  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakePostgresDriver).as('postgres');
    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('compiles to LIKE with ESCAPE and the wildcards of the text escaped', () => {
    const connection = DI.get(Orm)!.Connections.get('postgres')!;
    const result = connection.Container.resolve(SelectQueryBuilder, [connection]).select('*').from('t').where('name', 'like', LikeLiteral.endsWith('100%_\\')).toDB();

    expect(result.expression).to.contain(`"name" LIKE ? ESCAPE '~'`);
    expect(result.bindings).to.deep.eq(['%100~%~_\\']);
  });
});
