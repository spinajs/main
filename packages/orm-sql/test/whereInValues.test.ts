import 'mocha';
import { expect } from 'chai';
// Registers the concrete logger, as every suite in this package does.
import '@spinajs/log';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument } from '@spinajs/exceptions';
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

describe('whereIn and whereNotIn refuse NaN as where() does', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  for (const list of [[NaN], [1, NaN], [1, 2, Number.NaN]]) {
    it(`whereIn([${list.join(', ')}]) throws`, () => {
      expect(() => sqb().select('*').from('users').whereIn('id', list)).to.throw(InvalidArgument, 'value cannot be NaN');
    });

    it(`whereNotIn([${list.join(', ')}]) throws`, () => {
      expect(() => sqb().select('*').from('users').whereNotIn('id', list)).to.throw(InvalidArgument, 'value cannot be NaN');
    });
  }

  it('an array value of where({ ... }) throws', () => {
    expect(() => sqb().select('*').from('users').where({ id: [1, NaN] })).to.throw(InvalidArgument, 'value cannot be NaN');
  });

  it('where() keeps refusing NaN with the same error', () => {
    expect(() => sqb().select('*').from('users').where('id', NaN)).to.throw(InvalidArgument, 'value cannot be NaN');
    expect(() => sqb().select('*').from('users').where('id', '=', NaN)).to.throw(InvalidArgument, 'value cannot be NaN');
  });

  it('a list of numbers compiles as before', () => {
    const result = compiled(sqb().select('*').from('users').whereIn('id', [1, 2, 3]));

    expect(result.expression).to.eq('SELECT * FROM `users` WHERE `id` IN (?,?,?)');
    expect(result.bindings).to.deep.eq([1, 2, 3]);
  });

  it('a NOT IN list of text compiles as before', () => {
    const result = compiled(sqb().select('*').from('users').whereNotIn('name', ['a', 'b']));

    expect(result.expression).to.eq('SELECT * FROM `users` WHERE `name` NOT IN (?,?)');
    expect(result.bindings).to.deep.eq(['a', 'b']);
  });

  it('null and Infinity in a list are still bound as before', () => {
    const result = compiled(sqb().select('*').from('users').whereIn('id', [0, null, Infinity]));

    expect(result.expression).to.eq('SELECT * FROM `users` WHERE `id` IN (?,?,?)');
    expect(result.bindings).to.deep.eq([0, null, Infinity]);
  });
});
