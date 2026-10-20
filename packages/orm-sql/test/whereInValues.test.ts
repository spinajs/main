import 'mocha';
import { expect } from 'chai';
// Registers the concrete logger, as every suite in this package does.
import '@spinajs/log';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Connection, ICompilerOutput, Json, Model, ModelBase, Orm, Primary, SelectQueryBuilder } from '@spinajs/orm';
import { DateTime } from 'luxon';
import { ConnectionConf, FakeSqliteDriver } from './fixture.js';

@Connection('sqlite')
@Model('gap_in_json')
class GapInJson extends ModelBase {
  @Primary()
  public Id: number;

  @Json()
  public Data: unknown;
}

function compiled(query: { toDB(): ICompilerOutput | ICompilerOutput[] }): ICompilerOutput {
  return query.toDB() as ICompilerOutput;
}

function sqb() {
  const connection = DI.get(Orm)!.Connections.get('sqlite')!;
  return connection.Container.resolve(SelectQueryBuilder, [connection]);
}

describe('whereIn values', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('converts Date and DateTime values exactly like where() does', () => {
    const at = new Date('2022-07-21T09:35:31.820Z');
    const expected = compiled(sqb().select('*').from('users').where('CreatedAt', at)).bindings![0];

    const result = compiled(sqb().select('*').from('users').whereIn('CreatedAt', [at, DateTime.fromJSDate(at)]));

    expect(result.expression).to.eq('SELECT * FROM `users` WHERE `CreatedAt` IN (?,?)');
    expect(result.bindings).to.deep.eq([expected, expected]);
  });

  it('converts whereNotIn values too', () => {
    const at = new Date('2022-07-21T09:35:31.820Z');
    const expected = compiled(sqb().select('*').from('users').where('CreatedAt', at)).bindings![0];

    expect(compiled(sqb().select('*').from('users').whereNotIn('CreatedAt', [at])).bindings).to.deep.eq([expected]);
  });

  it("converts through the model column's declared converter", () => {
    const result = compiled(GapInJson.query().whereIn('Data', [{ a: 1 }]));

    expect(result.bindings).to.deep.eq(['{"a":1}']);
  });

  it('keeps a long list expanded when the dialect has no single-parameter form', () => {
    const result = compiled(
      sqb()
        .select('*')
        .from('users')
        .whereIn(
          'id',
          Array.from({ length: 1500 }, (_, i) => i),
        ),
    );

    expect(result.bindings).to.have.length(1500);
    expect(result.expression).to.contain('`id` IN (?,?,');
  });

  it('keeps its own class when cloned', () => {
    const query = sqb().select('*').from('users').whereIn('id', [1, 2]);

    expect(compiled(query.clone()).expression).to.eq('SELECT * FROM `users` WHERE `id` IN (?,?)');
  });
});
