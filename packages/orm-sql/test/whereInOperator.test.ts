import 'mocha';
import { expect } from 'chai';
// Registers the concrete logger, as every suite in this package does.
import '@spinajs/log';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument } from '@spinajs/exceptions';
import { Connection, ICompilerOutput, InQueryStatement, InStatement, Json, Model, ModelBase, Orm, Primary, RawQuery, SelectQueryBuilder } from '@spinajs/orm';
import { DateTime } from 'luxon';
import { ConnectionConf, FakeSqliteDriver } from './fixture.js';

@Connection('sqlite')
@Model('in_operator_json')
class InOperatorJson extends ModelBase {
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

function users() {
  return sqb().select('*').from('users');
}

function subQuery() {
  return sqb().select('UserId').from('orders');
}

function statementShape(query: SelectQueryBuilder): [boolean, boolean, string][] {
  return query.Statements.map((s) => [s instanceof InStatement, s instanceof InQueryStatement, s.Boolean]);
}

const at = new Date('2022-07-21T09:35:31.820Z');

const LISTS: [string, string, () => unknown[]][] = [
  ['numbers', 'id', () => [1, 2, 3]],
  ['a Date and a DateTime', 'CreatedAt', () => [at, DateTime.fromJSDate(at)]],
  ['one text value', 'Name', () => ['a']],
];

describe('where() with the in / not in operator', () => {
  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');
    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('compiles in to a list of parameters', () => {
    const result = compiled(users().where('id', 'in', [1, 2]));

    expect(result.expression).to.eq('SELECT * FROM `users` WHERE `id` IN (?,?)');
    expect(result.bindings).to.deep.eq([1, 2]);
  });

  it('compiles not in to a list of parameters', () => {
    const result = compiled(users().where('id', 'not in', [1, 2]));

    expect(result.expression).to.eq('SELECT * FROM `users` WHERE `id` NOT IN (?,?)');
    expect(result.bindings).to.deep.eq([1, 2]);
  });

  for (const [shape, column, list] of LISTS) {
    it(`compiles in exactly as whereIn() for ${shape}`, () => {
      expect(compiled(users().where(column, 'in', list()))).to.deep.eq(compiled(users().whereIn(column, list())));
    });

    it(`compiles not in exactly as whereNotIn() for ${shape}`, () => {
      expect(compiled(users().where(column, 'not in', list()))).to.deep.eq(compiled(users().whereNotIn(column, list())));
    });
  }

  it("converts through the model column's declared converter as whereIn() does", () => {
    const routed = compiled(InOperatorJson.query().where('Data', 'in', [{ a: 1 }]));

    expect(routed).to.deep.eq(compiled(InOperatorJson.query().whereIn('Data', [{ a: 1 }])));
    expect(routed.bindings).to.deep.eq(['{"a":1}']);
  });

  it('accepts the operator in upper case', () => {
    expect(compiled(users().where('id', 'IN', [1, 2]))).to.deep.eq(compiled(users().whereIn('id', [1, 2])));
    expect(compiled(users().where('id', 'NOT IN', [1, 2]))).to.deep.eq(compiled(users().whereNotIn('id', [1, 2])));
  });

  it('compiles an empty list as whereIn() and whereNotIn() do', () => {
    expect(compiled(users().where('id', 'in', [])).expression).to.eq('SELECT * FROM `users` WHERE 1 = 0');
    expect(compiled(users().where('id', 'not in', [])).expression).to.eq('SELECT * FROM `users` WHERE 1 = 1');
    expect(compiled(users().where('id', 'in', []))).to.deep.eq(compiled(users().whereIn('id', [])));
    expect(compiled(users().where('id', 'not in', []))).to.deep.eq(compiled(users().whereNotIn('id', [])));
  });

  it('keeps the or connector of orWhere()', () => {
    const result = compiled(users().where('Name', 'a').orWhere('id', 'in', [2, 3]));

    expect(result.expression).to.eq('SELECT * FROM `users` WHERE `Name` = ? OR `id` IN (?,?)');
    expect(result.bindings).to.deep.eq(['a', 2, 3]);
    expect(compiled(users().where('Name', 'a').orWhere('id', 'not in', [2])).expression).to.eq('SELECT * FROM `users` WHERE `Name` = ? OR `id` NOT IN (?)');
  });

  it('keeps the and connector of andWhere()', () => {
    const result = compiled(users().where('Name', 'a').orWhere('id', '>', 0).andWhere('id', 'in', [2, 3]));

    expect(result.expression).to.eq('SELECT * FROM `users` WHERE `Name` = ? OR `id` > ? AND `id` IN (?,?)');
    expect(result.bindings).to.deep.eq(['a', 0, 2, 3]);
  });

  it('puts the same statements with the same connectors on the query as whereIn() and whereNotIn()', () => {
    expect(statementShape(users().where('Name', 'a').orWhere('id', 'in', [1]))).to.deep.eq([
      [false, false, 'and'],
      [true, false, 'or'],
    ]);
    expect(statementShape(users().where('id', 'in', [1]))).to.deep.eq(statementShape(users().whereIn('id', [1])));
    expect(statementShape(users().where('id', 'not in', [1]))).to.deep.eq(statementShape(users().whereNotIn('id', [1])));
    expect(statementShape(users().where('id', 'in', subQuery()))).to.deep.eq(statementShape(users().whereIn('id', subQuery())));
  });

  it('compiles a sub-query exactly as whereIn() and whereNotIn() do', () => {
    const routed = compiled(users().where('id', 'in', subQuery()));

    expect(routed.expression).to.eq('SELECT * FROM `users` WHERE `id` IN ( SELECT `UserId` FROM `orders` )');
    expect(routed).to.deep.eq(compiled(users().whereIn('id', subQuery())));
    expect(compiled(users().where('id', 'not in', subQuery()))).to.deep.eq(compiled(users().whereNotIn('id', subQuery())));
  });

  it('keeps a RawQuery value as it was', () => {
    const result = compiled(users().where('id', 'in', RawQuery.create('(1, 2)')));

    expect(result.expression).to.eq('SELECT * FROM `users` WHERE `id` IN (1, 2)');
    expect(result.bindings).to.deep.eq([]);
  });

  it('refuses a value that is neither a list nor a sub-query', () => {
    expect(() => users().where('id', 'in', 5)).to.throw(InvalidArgument, 'operator in takes an array, a sub-query or a RawQuery');
    expect(() => users().where('id', 'NOT IN', '1,2')).to.throw(InvalidArgument, 'operator NOT IN takes an array, a sub-query or a RawQuery');
  });

  it('does not echo the refused value', () => {
    const large = 'x'.repeat(10_000);

    expect(() => users().where('id', 'in', large))
      .to.throw(InvalidArgument)
      .with.property('message')
      .that.does.not.contain('xxxx');
  });

  it('compiles every other operator as before', () => {
    const cases: [string, unknown, string, unknown[]][] = [
      ['=', 2, '`id` = ?', [2]],
      ['!=', 2, '`id` != ?', [2]],
      ['<>', 2, '`id` <> ?', [2]],
      ['<', 3, '`id` < ?', [3]],
      ['like', 'a%', '`id` LIKE ?', ['a%']],
      ['between', [1, 3], '`id` BETWEEN ? AND ?', [1, 3]],
      ['not between', [1, 3], '`id` NOT BETWEEN ? AND ?', [1, 3]],
    ];

    for (const [operator, value, expression, bindings] of cases) {
      const result = compiled(users().where('id', operator, value));
      expect(result.expression, operator).to.eq(`SELECT * FROM \`users\` WHERE ${expression}`);
      expect(result.bindings, operator).to.deep.eq(bindings);
    }
  });
});
