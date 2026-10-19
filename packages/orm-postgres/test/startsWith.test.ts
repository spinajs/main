import 'mocha';
import { expect } from 'chai';
// Registers the concrete logger; Orm.resolve() logs through it.
import '@spinajs/log';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { ICompilerOutput, Orm, SelectQueryBuilder } from '@spinajs/orm';
import { ConnectionConf, FakePostgresDriver } from './fixture.js';

describe('postgres whereStartsWith', function () {
  this.timeout(15000);

  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakePostgresDriver).as('postgres');
    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('compiles to LIKE with ESCAPE and the wildcards of the prefix escaped', () => {
    const connection = DI.get(Orm)!.Connections.get('postgres')!;
    const result = connection.Container.resolve(SelectQueryBuilder, [connection]).select('*').from('t').whereStartsWith('path', '100%_/').toDB() as ICompilerOutput;

    expect(result.expression).to.contain(`"path" LIKE ? ESCAPE '~'`);
    expect(result.bindings).to.deep.eq(['100~%~_/%']);
  });
});
