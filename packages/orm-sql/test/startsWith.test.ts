/* eslint-disable prettier/prettier */
import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument } from '@spinajs/exceptions';
import { ICompilerOutput, Orm, SelectQueryBuilder, StartsWithStatement } from '@spinajs/orm';

import { ConnectionConf, FakeSqliteDriver } from './fixture.js';
import { SqlStartsWithStatement } from '../src/statements.js';

describe('portable prefix statement', function () {
  this.timeout(15000);

  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');

    await DI.resolve(Orm);
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
    expect(connection().Container.resolve<StartsWithStatement>(StartsWithStatement, ['Path', 'a/', undefined])).to.be.instanceOf(SqlStartsWithStatement);
  });

  it('compiles to LIKE with every wildcard of the prefix escaped', () => {
    const result = compiled(sqb().select('*').from('files').whereStartsWith('Path', 'docs[1]_~%/'));

    expect(result.expression).to.contain("`Path` LIKE ? ESCAPE '~'");
    expect(result.bindings).to.deep.eq(['docs[1]~_~~~%/%']);
  });

  it('keeps the statement when the query is cloned', () => {
    const query = sqb().select('*').from('files').whereStartsWith('Path', 'a/');

    expect(compiled(query.clone()).expression).to.contain("`Path` LIKE ? ESCAPE '~'");
  });

  it('refuses a prefix that is not a string', () => {
    expect(() => compiled(sqb().select('*').from('files').whereStartsWith('Path', null as unknown as string))).to.throw(InvalidArgument, 'whereStartsWith(Path) takes a string prefix, got null');
  });
});
