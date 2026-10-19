/* eslint-disable @typescript-eslint/no-floating-promises */
import 'mocha';
import { expect } from 'chai';
// Registers the concrete logger. Without it every `@Logger` field resolves the abstract
// `Log` from log-common and the first `Log.trace()` in Orm.resolve() throws.
import '@spinajs/log';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { ICompilerOutput, Orm, SelectQueryBuilder } from '@spinajs/orm';
import { ConnectionConf, FakePostgresDriver } from './fixture.js';

function sqb() {
  const connection = DI.get(Orm)!.Connections.get('postgres')!;
  return connection.Container.resolve(SelectQueryBuilder, [connection]);
}

function compiled(query: { toDB(): ICompilerOutput | ICompilerOutput[] }): ICompilerOutput {
  return query.toDB() as ICompilerOutput;
}

const list = (count: number) => Array.from({ length: count }, (_, i) => i);

describe('postgres whereIn', function () {
  this.timeout(15000);

  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakePostgresDriver).as('postgres');
    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('binds a list longer than 1000 as one array parameter', () => {
    const result = compiled(sqb().select('*').from('t').whereIn('id', list(1001)));

    expect(result.expression).to.contain('"id" = ANY(?)');
    expect(result.bindings).to.deep.eq([list(1001)]);
  });

  it('uses <> ALL for whereNotIn', () => {
    expect(compiled(sqb().select('*').from('t').whereNotIn('id', list(1001))).expression).to.contain('"id" <> ALL(?)');
  });

  it('keeps a list of 1000 expanded', () => {
    const result = compiled(sqb().select('*').from('t').whereIn('id', list(1000)));

    expect(result.expression).to.contain('"id" IN (?,?,');
    expect(result.bindings).to.have.length(1000);
  });

  it('keeps a long list of values JSON cannot carry expanded', () => {
    const result = compiled(
      sqb()
        .select('*')
        .from('t')
        .whereIn(
          'id',
          Array.from({ length: 1001 }, () => Buffer.from('a')),
        ),
    );

    expect(result.bindings).to.have.length(1001);
  });
});
