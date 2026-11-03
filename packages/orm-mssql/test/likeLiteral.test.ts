import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { ICompilerOutput, LikeLiteral, QueryContext, SqlOperator, WhereStatement } from '@spinajs/orm';
import '@spinajs/log';
import { MsSqlOrmDriver } from '../src/index.js';
import { MsSqlWhereStatement } from '../src/statements.js';

function compiled(query: { toDB(): ICompilerOutput | ICompilerOutput[] }): ICompilerOutput {
  return query.toDB() as ICompilerOutput;
}

describe('mssql LikeLiteral', function () {
  this.timeout(15000);

  let driver: MsSqlOrmDriver;

  beforeEach(async () => {
    driver = await DI.resolve(MsSqlOrmDriver, [{ Name: 'mssql-like-test', Driver: 'orm-driver-mssql' } as any]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('uses the mssql implementation', () => {
    const builder = driver.select().from('t');
    expect(driver.Container.resolve<WhereStatement>(WhereStatement, ['name', SqlOperator.EQ, 1, builder])).to.be.instanceOf(MsSqlWhereStatement);
  });

  it('escapes [ as well as the LIKE wildcards', () => {
    const result = compiled(driver.select().from('t').where('name', 'like', LikeLiteral.contains('docs[1]_%')));

    expect(result.expression).to.contain("[name] LIKE ? ESCAPE '~'");
    expect(result.bindings).to.deep.eq(['%docs~[1]~_~%%']);
  });

  it('keeps the bracket escape when the query is cloned', () => {
    expect(compiled(driver.select().from('t').where('name', 'like', LikeLiteral.startsWith('docs[1]')).clone()).bindings).to.deep.eq(['docs~[1]%']);
  });

  it('leaves a plain string operand a raw pattern', () => {
    const result = compiled(driver.select().from('t').where('name', 'like', '[a-c]%'));

    expect(result.expression).to.not.contain('ESCAPE');
    expect(result.bindings).to.deep.eq(['[a-c]%']);
  });
});

const NAMES = ['100%', '1000', 'a_b', 'axb', 'b\\s', 'bxs', '~t', 'xt', 'docs[1]', 'docs1', 'Plain'];

const CASES: [LikeLiteral, string[]][] = [
  [LikeLiteral.contains('%'), ['100%']],
  [LikeLiteral.contains('_'), ['a_b']],
  [LikeLiteral.contains('\\'), ['b\\s']],
  [LikeLiteral.contains('~'), ['~t']],
  [LikeLiteral.contains('[1]'), ['docs[1]']],
  [LikeLiteral.contains('plain'), ['Plain']],
  [LikeLiteral.startsWith('a_'), ['a_b']],
  [LikeLiteral.endsWith('0%'), ['100%']],
];

// Against the server mssql.test.ts uses ( docker compose --profile test up -d mssql ).
describe('mssql LikeLiteral against the server', function () {
  this.timeout(30000);

  let driver: MsSqlOrmDriver;

  before(async () => {
    driver = await DI.child().resolve(MsSqlOrmDriver, [
      { Name: 'mssql-like-live', Driver: 'orm-driver-mssql', Host: 'localhost', User: 'sa', Password: 'yourStrong(!)Password', Database: 'test', Options: { TrustServerCertificate: true, Schema: 'dbo' } } as any,
    ]);
    await driver.connect();
    await driver.executeOnDb('DROP TABLE IF EXISTS like_literal_t', [], QueryContext.Schema);
    await driver.executeOnDb('CREATE TABLE like_literal_t (Id INT PRIMARY KEY, Name NVARCHAR(64) NULL)', [], QueryContext.Schema);
    await driver
      .insert()
      .into('like_literal_t')
      .values([...NAMES.map((Name, Id) => ({ Id, Name })), { Id: 99, Name: null }]);
  });

  after(async () => {
    await driver?.executeOnDb('DROP TABLE IF EXISTS like_literal_t', [], QueryContext.Schema);
    await driver?.disconnect();
  });

  for (const [literal, expected] of CASES) {
    it(`${literal.Match} ${JSON.stringify(literal.Text)} matches literally, case as LIKE does`, async () => {
      const rows = await driver.select().select('Name').from('like_literal_t').where('Name', 'like', literal).asRaw<{ Name: string }[]>();

      expect(rows.map((r) => r.Name).sort()).to.deep.eq(expected);
    });
  }
});
