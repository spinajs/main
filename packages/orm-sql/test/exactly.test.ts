import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument } from '@spinajs/exceptions';
import { ExactlyStatement, ICompilerOutput, IWhereBuilder, Orm,SelectQueryBuilder, SqlExpressions, SqlFragment, UpdateQueryBuilder } from '@spinajs/orm';

import { ConnectionConf, FakeSqliteDriver } from './fixture.js';
import { SqlExactlyStatement } from '../src/statements.js';

class BinaryExpressions extends SqlExpressions {
  public equalsExactly(left: string, right: SqlFragment): SqlFragment {
    return { sql: `BINARY(${left}) = BINARY(${right.sql})`, bindings: [...right.bindings] };
  }
}

describe('byte-exact equality statement', function () {
  this.timeout(15000);

  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');

    await DI.resolve(Orm);
    connection().Container.register(BinaryExpressions).as(SqlExpressions);
  });

  afterEach(() => {
    DI.clearCache();
  });

  function connection() {
    return DI.get(Orm)!.Connections.get('sqlite')!;
  }

  function sqb() {
    return connection().Container.resolve<SelectQueryBuilder>(SelectQueryBuilder, [connection()]);
  }

  const compiled = (query: { toDB(): ICompilerOutput | ICompilerOutput[] }): ICompilerOutput => query.toDB() as ICompilerOutput;

  it('resolves the portable implementation', () => {
    expect(connection().Container.resolve<ExactlyStatement>(ExactlyStatement, ['Path', 'a', undefined])).to.be.instanceOf(SqlExactlyStatement);
  });

  it('compiles the plain equality beside the dialect exact one', () => {
    const result = compiled(sqb().select('*').from('files').whereExactly('Path', 'K7'));

    expect(result.expression).to.contain('(`Path` = ? AND BINARY(`Path`) = BINARY(?))');
    expect(result.bindings).to.deep.eq(['K7', 'K7']);
  });

  it('qualifies the column with the table alias', () => {
    const result = compiled(sqb().select('*').from('files', 'f').whereExactly('Path', 'K7'));

    expect(result.expression).to.contain('(`f`.`Path` = ? AND BINARY(`f`.`Path`) = BINARY(?))');
  });

  it('compiles inside a nested where of an update', () => {
    const update = connection().Container.resolve<UpdateQueryBuilder<unknown>>(UpdateQueryBuilder, [connection()]);
    const result = compiled(
      update
        .in('files')
        .update({ data: '' })
        .where(function (this: IWhereBuilder<unknown>) {
          this.whereExactly('Path', 'K7');
        }),
    );

    expect(result.expression).to.contain('(`Path` = ? AND BINARY(`Path`) = BINARY(?))');
  });

  it('keeps the statement when the query is cloned', () => {
    const query = sqb().select('*').from('files').whereExactly('Path', 'K7');

    expect(compiled(query.clone()).expression).to.contain('(`Path` = ? AND BINARY(`Path`) = BINARY(?))');
  });

  it('refuses a value that is not a string', () => {
    expect(() => compiled(sqb().select('*').from('files').whereExactly('Path', 7 as unknown as string))).to.throw(InvalidArgument, 'whereExactly(Path) takes a string value, got number');
  });
});
