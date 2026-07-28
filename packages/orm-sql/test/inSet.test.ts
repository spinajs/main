/* eslint-disable prettier/prettier */
import { expect } from 'chai';
import 'mocha';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument } from '@spinajs/exceptions';
import { InSetStatement, Orm, SelectQueryBuilder } from '@spinajs/orm';

import { ConnectionConf, FakeSqliteDriver } from './fixture.js';
import { SqlInSetStatement } from '../src/statements.js';

/**
 * The portable membership test — what a driver gets when it does not register a
 * dialect one of its own.
 *
 * It replaced `FIND_IN_SET`, which is MySQL only and was inherited by every other
 * driver from this package. These assertions are on the SQL text on purpose: the
 * whole failure was "the emitted SQL is for another database", and that is only
 * visible in the emitted SQL.
 */
describe('portable set membership statement', function () {
  this.timeout(15000);

  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(FakeSqliteDriver).as('sqlite');

    await DI.resolve(Orm);
  });

  afterEach(() => {
    DI.clearCache();
  });

  function statement(values: any[], not = false): InSetStatement {
    const connection = DI.get(Orm)!.Connections.get('sqlite')!;
    return connection.Container.resolve<InSetStatement>(InSetStatement, ['Role', values, not, undefined]);
  }

  function sqb() {
    const connection = DI.get(Orm)!.Connections.get('sqlite')!;
    return connection.Container.resolve<SelectQueryBuilder>(SelectQueryBuilder, [connection]);
  }

  it('is the portable implementation, not the MySQL one', () => {
    expect(statement(['admin'])).to.be.instanceOf(SqlInSetStatement);
  });

  it('emits no vendor function', () => {
    const { Statements } = statement(['admin']).build();

    expect(Statements[0]).to.not.match(/FIND_IN_SET|instr|CHARINDEX/i);
  });

  it('matches the value alone, first, last and in the middle', () => {
    const { Statements, Bindings } = statement(['admin']).build();

    expect(Statements[0]).to.eq("((`Role` = ? OR `Role` LIKE ? ESCAPE '~' OR `Role` LIKE ? ESCAPE '~' OR `Role` LIKE ? ESCAPE '~'))");
    expect(Bindings).to.deep.eq(['admin', 'admin,%', '%,admin', '%,admin,%']);
  });

  it('ORs several values together', () => {
    const { Statements, Bindings } = statement(['admin', 'user']).build();

    expect(Statements[0].split(' OR (').length - 1, 'one group per value').to.eq(1);
    expect(Statements[0]).to.match(/^\(\(.*\) OR \(.*\)\)$/);
    expect(Bindings).to.have.lengthOf(8);
  });

  it('ANDs the negation of every value', () => {
    const { Statements } = statement(['admin', 'user'], true).build();

    expect(Statements[0]).to.match(/^\(NOT \(.*\) AND NOT \(.*\)\)$/);
  });

  it('matches nothing for an empty value list, and everything for its negation', () => {
    expect(statement([]).build().Statements[0]).to.eq('(1 = 0)');
    expect(statement([], true).build().Statements[0]).to.eq('(1 = 1)');
  });

  /**
   * A role named `admin_1` must not match `adminX1`. LIKE metacharacters in the
   * VALUE are escaped; the escape character is `~` rather than a backslash because
   * `ESCAPE '\'` is a syntax error in MySQL.
   */
  it('escapes LIKE metacharacters in the value', () => {
    const { Bindings } = statement(['admin_1']).build();

    expect(Bindings).to.deep.eq(['admin_1', 'admin~_1,%', '%,admin~_1', '%,admin~_1,%']);
  });

  it('escapes the escape character itself', () => {
    const { Bindings } = statement(['a~b']).build();

    expect(Bindings[1]).to.eq('a~~b,%');
  });

  /**
   * A value holding the delimiter cannot be stored in such a column at all, so
   * searching for it can only ever match a row where two neighbouring entries
   * happen to sit next to each other. Refused rather than answered wrongly —
   * `FIND_IN_SET` answered it wrongly.
   */
  it('refuses a value containing the set delimiter', () => {
    expect(() => statement(['admin,user']).build()).to.throw(InvalidArgument, /delimiter/);
  });

  it('refuses a null value', () => {
    expect(() => statement([null]).build()).to.throw(InvalidArgument);
  });

  it('reaches the compiled query through whereInSet', () => {
    const result = sqb().select('*').from('users').whereInSet('Role', ['admin']).toDB() as any;

    expect(result.expression).to.contain('LIKE');
    expect(result.bindings).to.include('admin');
  });
});
