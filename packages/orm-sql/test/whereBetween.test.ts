import 'mocha';
import { expect } from 'chai';
import '@spinajs/log';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument } from '@spinajs/exceptions';
import { Connection, extractDecoratorPropertyDescriptor, ICompilerOutput, IModelDescriptor, Model, ModelBase, Orm, Primary, RawQuery, SelectQueryBuilder, SqlOperator, ValueConverter } from '@spinajs/orm';
import { ConnectionConf, FakeSqliteDriver } from './fixture.js';

class TaggingConverter extends ValueConverter {
  public toDB(value: unknown, _model: ModelBase, _column: unknown, options: { Tag: string }): unknown {
    return `${options.Tag}:${String(value)}`;
  }
}

function Tagged(tag: string): PropertyDecorator {
  const decorator: PropertyDecorator = extractDecoratorPropertyDescriptor((model: IModelDescriptor, _: unknown, propertyKey: string) => {
    model.Converters.set(propertyKey, { Class: TaggingConverter, Options: { Tag: tag } });
  });
  return decorator;
}

@Connection('sqlite')
@Model('gap_between_tagged')
class GapBetweenTagged extends ModelBase {
  // The primary key passes the column check, which the fake driver's missing table info would fail otherwise.
  @Primary()
  @Tagged('pk')
  public Id: number;
}

@Connection('sqlite')
@Model('gap_between_ref')
class GapBetweenRef extends ModelBase {
  @Primary()
  public Id: number;
}

@Connection('sqlite')
@Model('gap_between_pair_key')
class GapBetweenPairKey extends ModelBase {
  @Primary()
  public A: number;

  @Primary()
  public B: number;
}

function compiled(query: { toDB(): ICompilerOutput | ICompilerOutput[] }): ICompilerOutput {
  return query.toDB() as ICompilerOutput;
}

function sqb() {
  const connection = DI.get(Orm)!.Connections.get('sqlite')!;
  return connection.Container.resolve(SelectQueryBuilder, [connection]);
}

describe('where() with the BETWEEN operator', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('binds both members of the pair', () => {
    const result = compiled(sqb().select('*').from('users').where('id', SqlOperator.BETWEEN, [1, 2]));

    expect(result.expression).to.eq('SELECT * FROM `users` WHERE `id` BETWEEN ? AND ?');
    expect(result.bindings).to.deep.eq([1, 2]);
  });

  it('emits NOT BETWEEN, whatever the operator case', () => {
    const result = compiled(sqb().select('*').from('users').where('id', 'NOT BETWEEN' as SqlOperator, [1, 2]));

    expect(result.expression).to.eq('SELECT * FROM `users` WHERE `id` NOT BETWEEN ? AND ?');
    expect(result.bindings).to.deep.eq([1, 2]);
  });

  it('keeps the connector of orWhere', () => {
    const result = compiled(sqb().select('*').from('users').where('id', 5).orWhere('id', SqlOperator.BETWEEN, [1, 2]));

    expect(result.expression).to.eq('SELECT * FROM `users` WHERE `id` = ? OR `id` BETWEEN ? AND ?');
    expect(result.bindings).to.deep.eq([5, 1, 2]);
  });

  it('converts each bound exactly like a single value', () => {
    const from = new Date('2022-07-21T09:35:31.820Z');
    const to = new Date('2022-07-22T09:35:31.820Z');
    const expected = [from, to].map((at): unknown => compiled(sqb().select('*').from('users').where('CreatedAt', at)).bindings![0]);

    expect(compiled(sqb().select('*').from('users').where('CreatedAt', SqlOperator.BETWEEN, [from, to])).bindings).to.deep.eq(expected);
  });

  it("converts both bounds through the column's declared converter, with its options", () => {
    expect(compiled(GapBetweenTagged.query().where('Id', SqlOperator.BETWEEN, [1, 2])).bindings).to.deep.eq(['pk:1', 'pk:2']);
  });

  it("converts whereIn values through the column's declared converter, with its options", () => {
    expect(compiled(GapBetweenTagged.query().whereIn('Id', [1, 2])).bindings).to.deep.eq(['pk:1', 'pk:2']);
  });

  it('binds a model bound as its primary key', () => {
    const result = compiled(sqb().select('*').from('users').where('id', SqlOperator.BETWEEN, [new GapBetweenRef({ Id: 7 }), new GapBetweenRef({ Id: 9 })]));

    expect(result.bindings).to.deep.eq([7, 9]);
  });

  it('refuses a model bound with a composite primary key', () => {
    const query = sqb().select('*').from('users').where('id', SqlOperator.BETWEEN, [new GapBetweenPairKey({ A: 1, B: 2 }), 5]);

    expect(() => compiled(query)).to.throw(InvalidArgument, /composite primary key/);
  });

  it('takes a RawQuery as the whole range', () => {
    const between = compiled(sqb().select('*').from('users').where('id', SqlOperator.BETWEEN, RawQuery.create('? AND ?', [1, 2])));
    expect(between.expression).to.eq('SELECT * FROM `users` WHERE `id` BETWEEN ? AND ?');
    expect(between.bindings).to.deep.eq([1, 2]);

    const notBetween = compiled(sqb().select('*').from('users').where('id', SqlOperator.NOT_BETWEEN, RawQuery.create('? AND ?', [1, 2])));
    expect(notBetween.expression).to.eq('SELECT * FROM `users` WHERE `id` NOT BETWEEN ? AND ?');
    expect(notBetween.bindings).to.deep.eq([1, 2]);
  });

  it('refuses a RawQuery as one bound', () => {
    expect(() => sqb().select('*').from('users').where('id', SqlOperator.BETWEEN, [RawQuery.create('NOW()'), 1])).to.throw(InvalidArgument);
  });

  it('reads the table alias at build time', () => {
    const query = sqb().select('*').from('users').where('id', SqlOperator.BETWEEN, [1, 2]);
    query.setAlias('u');

    expect(compiled(query).expression).to.contain('`u`.`id` BETWEEN ? AND ?');
  });

  it('survives a clone', () => {
    const query = sqb().select('*').from('users').where('id', SqlOperator.BETWEEN, [1, 2]);

    expect(compiled(query.clone()).expression).to.eq('SELECT * FROM `users` WHERE `id` BETWEEN ? AND ?');
  });

  it('refuses anything but a pair of values', () => {
    expect(() => sqb().select('*').from('users').where('id', SqlOperator.BETWEEN, [1])).to.throw(InvalidArgument);
    expect(() => sqb().select('*').from('users').where('id', SqlOperator.BETWEEN, [1, 2, 3])).to.throw(InvalidArgument);
    expect(() => sqb().select('*').from('users').where('id', SqlOperator.BETWEEN, 1)).to.throw(InvalidArgument);
    expect(() => sqb().select('*').from('users').where('id', SqlOperator.BETWEEN, [1, null])).to.throw(InvalidArgument);
  });
});
