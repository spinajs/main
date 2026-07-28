import 'mocha';
import { expect } from 'chai';

import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { IdentifierQuoter, InSetStatement } from '@spinajs/orm';

import { MsSqlOrmDriver } from '../src/index.js';
import { MsSqlInSetStatement } from '../src/statements.js';

/**
 * MSSQL's side of the dialect contract.
 *
 * Runs without a database for the same reason the MySQL one does: resolving the
 * driver is what registers its dialect classes, and a statement can be built and
 * read back without a server to execute it.
 */
describe('mssql dialect', function () {
  this.timeout(15000);

  let driver: MsSqlOrmDriver;

  beforeEach(async () => {
    driver = await DI.resolve(MsSqlOrmDriver, [{ Name: 'mssql-dialect-test', Driver: 'orm-driver-mssql' } as any]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  /**
   * Brackets, not backticks. This driver imported the shared BACKTICK helper directly,
   * so every identifier a shared compiler produced for SQL Server came out as
   * `` `table` `` — invalid T-SQL that no compiler override could fix, because
   * shadowing a compiler does not shadow a function it calls internally.
   */
  it('quotes with brackets', () => {
    const quoter = driver.Container.resolve<IdentifierQuoter>(IdentifierQuoter);

    expect(quoter.quote('Role')).to.eq('[Role]');
    expect(quoter.quote('we]rd')).to.eq('[we]]rd]');
    expect(quoter.quoteQualified('dbo.users')).to.eq('[dbo].[users]');
  });

  /**
   * `CHANGE COLUMN`, `ALTER TABLE ... RENAME TO`, `CREATE TABLE ... LIKE`,
   * `WITH RECURSIVE` and `CURRENT_DATE()` are not T-SQL. This driver registers none of
   * them, so they fail by name instead of reaching SQL Server as MySQL syntax.
   */
  it('leaves the abstractions it has no T-SQL for unregistered', () => {
    for (const abstraction of ['AlterColumnQueryCompiler', 'AlterTableQueryCompiler', 'TableCloneQueryCompiler', 'RecursiveQueryCompiler', 'DefaultValueBuilder']) {
      expect(driver.Container.hasRegistered(abstraction), `${abstraction} must not be inherited from the MySQL-flavoured base`).to.eq(false);
    }
  });

  describe('set membership', () => {
    const statement = (values: any[], not = false) => driver.Container.resolve<InSetStatement>(InSetStatement, ['Role', values, not, undefined]);

    it('uses the mssql implementation', () => {
      expect(statement(['admin'])).to.be.instanceOf(MsSqlInSetStatement);
    });

    /**
     * CHARINDEX with `+` concatenation. MSSQL has neither `FIND_IN_SET` — which it
     * used to inherit and fail on — nor the `||` operator SQLite uses.
     */
    it('compiles to CHARINDEX', () => {
      const { Statements, Bindings } = statement(['admin']).build();

      expect(Statements[0]).to.contain('CHARINDEX(?');
      expect(Statements[0]).to.not.contain('FIND_IN_SET');
      expect(Bindings).to.deep.eq([',admin,']);
    });

    it('ORs several values together', () => {
      const { Statements, Bindings } = statement(['admin', 'user']).build();

      expect(Statements[0].match(/CHARINDEX/g)).to.have.lengthOf(2);
      expect(Statements[0]).to.match(/^\(\(.*\) OR \(.*\)\)$/);
      expect(Bindings).to.deep.eq([',admin,', ',user,']);
    });

    it('ANDs the negation of every value', () => {
      const { Statements } = statement(['admin', 'user'], true).build();

      expect(Statements[0]).to.match(/^\(NOT \(.*\) AND NOT \(.*\)\)$/);
    });

    it('matches nothing for an empty value list, and everything for its negation', () => {
      expect(statement([]).build().Statements[0]).to.eq('(1 = 0)');
      expect(statement([], true).build().Statements[0]).to.eq('(1 = 1)');
    });

    it('refuses a value containing the set delimiter', () => {
      expect(() => statement(['admin,user']).build()).to.throw(InvalidArgument, /delimiter/);
    });
  });
});
