import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument } from '@spinajs/exceptions';
import { ICompilerOutput, LikeLiteral, Orm, SelectQueryBuilder } from '@spinajs/orm';

import { ConnectionConf, FakeSqliteDriver } from './fixture.js';

describe('LikeLiteral where operand', function () {
  this.timeout(15000);

  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');

    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  function sqb() {
    const connection = DI.get(Orm)!.Connections.get('sqlite')!;
    return connection.Container.resolve<SelectQueryBuilder>(SelectQueryBuilder, [connection]).select('*').from('t');
  }

  const compiled = (query: { toDB(): ICompilerOutput | ICompilerOutput[] }): ICompilerOutput => query.toDB() as ICompilerOutput;

  it('compiles to LIKE with ESCAPE and every wildcard of the text escaped', () => {
    const result = compiled(sqb().where('Name', 'like', LikeLiteral.contains('5%_~\\')));

    expect(result.expression).to.contain("`Name` LIKE ? ESCAPE '~'");
    expect(result.bindings).to.deep.eq(['%5~%~_~~\\%']);
  });

  it('anchors startsWith and endsWith on the side they name', () => {
    expect(compiled(sqb().where('Name', 'like', LikeLiteral.startsWith('a_'))).bindings).to.deep.eq(['a~_%']);
    expect(compiled(sqb().where('Name', 'like', LikeLiteral.endsWith('a_'))).bindings).to.deep.eq(['%a~_']);
  });

  it('accepts the operator in any case', () => {
    expect(compiled(sqb().where('Name', 'LIKE', LikeLiteral.contains('a'))).expression).to.contain("`Name` LIKE ? ESCAPE '~'");
  });

  it('keeps its connector inside an OR', () => {
    const result = compiled(sqb().where('Id', 1).orWhere('Name', 'like', LikeLiteral.contains('%')));

    expect(result.expression).to.contain("`Id` = ? OR `Name` LIKE ? ESCAPE '~'");
    expect(result.bindings).to.deep.eq([1, '%~%%']);
  });

  it('keeps the escape when the query is cloned', () => {
    const result = compiled(sqb().where('Name', 'like', LikeLiteral.contains('_')).clone());

    expect(result.expression).to.contain("`Name` LIKE ? ESCAPE '~'");
    expect(result.bindings).to.deep.eq(['%~_%']);
  });

  it('leaves a plain string operand a raw pattern', () => {
    const result = compiled(sqb().where('Name', 'like', 'a_%'));

    expect(result.expression).to.contain('`Name` LIKE ?');
    expect(result.expression).to.not.contain('ESCAPE');
    expect(result.bindings).to.deep.eq(['a_%']);
  });

  it('refuses an operator other than like', () => {
    expect(() => sqb().where('Name', '=', LikeLiteral.contains('a'))).to.throw(InvalidArgument, 'a LikeLiteral is an operand of the like operator only, got =');
  });
});
