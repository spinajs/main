import 'mocha';
import { expect } from 'chai';

import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { IdentifierQuoter, InSetStatement } from '@spinajs/orm';

import { MySqlOrmDriver } from '../src/index.js';
import { MySqlInSetStatement } from '../src/statements.js';

/**
 * MySQL's side of the dialect contract.
 *
 * No database: resolving the driver registers its dialect classes into its own
 * container, and a statement can be built and inspected without anything to run it
 * against. That is deliberate — this suite has to run in CI, where the MySQL
 * container the rest of the package's tests need is not always up.
 */
describe('mysql dialect', function () {
  this.timeout(15000);

  let driver: MySqlOrmDriver;

  beforeEach(async () => {
    driver = await DI.resolve(MySqlOrmDriver, [{ Name: 'mysql-dialect-test', Driver: 'orm-driver-mysql' } as any]);
  });

  afterEach(() => {
    DI.clearCache();
  });

  /**
   * The MySQL dialect is registered by THIS driver now. It used to live in the shared
   * `SqlDriver`, which meant every other driver inherited MySQL's SQL under neutral
   * class names — `FIND_IN_SET` reaching SQLite is how that was found.
   */
  it('registers its own dialect classes', () => {
    for (const abstraction of ['OnDuplicateQueryCompiler', 'ColumnQueryCompiler', 'AlterColumnQueryCompiler', 'EventQueryCompiler', 'TableHistoryQueryCompiler', 'LimitQueryCompiler', 'TableCloneQueryCompiler']) {
      expect(driver.Container.hasRegistered(abstraction), `${abstraction} must be registered by the mysql driver itself`).to.eq(true);
    }
  });

  it('quotes with backticks', () => {
    const quoter = driver.Container.resolve<IdentifierQuoter>(IdentifierQuoter);

    expect(quoter.quote('Role')).to.eq('`Role`');
  });

  describe('set membership', () => {
    const statement = (values: any[], not = false) => driver.Container.resolve<InSetStatement>(InSetStatement, ['Role', values, not, undefined]);

    it('uses the mysql implementation', () => {
      expect(statement(['admin'])).to.be.instanceOf(MySqlInSetStatement);
    });

    /**
     * FIND_IN_SET stays MySQL's answer — it is the right one here. What changed is
     * where it lives: it used to be registered in `@spinajs/orm-sql`, which every
     * other driver inherits from, and they inherited a function their database does
     * not have.
     */
    it('compiles to FIND_IN_SET', () => {
      const { Statements, Bindings } = statement(['admin']).build();

      expect(Statements[0]).to.eq('((FIND_IN_SET(?, `Role`) > 0))');
      expect(Bindings).to.deep.eq(['admin']);
    });

    it('ORs several values together', () => {
      const { Statements, Bindings } = statement(['admin', 'user']).build();

      expect(Statements[0]).to.eq('((FIND_IN_SET(?, `Role`) > 0) OR (FIND_IN_SET(?, `Role`) > 0))');
      expect(Bindings).to.deep.eq(['admin', 'user']);
    });

    it('ANDs the negation of every value', () => {
      const { Statements } = statement(['admin', 'user'], true).build();

      expect(Statements[0]).to.eq('(NOT (FIND_IN_SET(?, `Role`) > 0) AND NOT (FIND_IN_SET(?, `Role`) > 0))');
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
