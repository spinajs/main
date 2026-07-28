/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument } from '@spinajs/exceptions';
import { IdentifierQuoter, InSetStatement, Orm, QueryContext, SelectQueryBuilder } from '@spinajs/orm';

import { SqliteOrmDriver } from '../src/index.js';
import { SqliteInSetStatement } from '../src/statements.js';
import { ConnectionConf } from './common.js';

/**
 * SQLite's dialect, resolved from SQLite's own container.
 *
 * `whereInSet` used to compile to `FIND_IN_SET` here — a MySQL function the shared
 * `@spinajs/orm-sql` driver registered and every other driver inherited — so every
 * query using it, `withRole` included, failed with "no such function". The fix is the
 * ordinary DI one: this driver registers its own statement. These tests pin both
 * halves — the registration, and that the SQL it produces finds the right rows.
 */
describe('sqlite dialect', function () {
  this.timeout(25000);

  let connection: SqliteOrmDriver;

  beforeEach(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');

    await DI.resolve(Configuration);
    const orm = await DI.resolve(Orm);
    connection = orm.Connections.get('sqlite') as SqliteOrmDriver;

    await connection.executeOnDb(`CREATE TABLE IF NOT EXISTS dialect_users (Id INTEGER PRIMARY KEY AUTOINCREMENT, Login TEXT, Role TEXT)`, [], QueryContext.Schema);
    await connection.executeOnDb(`DELETE FROM dialect_users`, [], QueryContext.Delete);
  });

  afterEach(async () => {
    DI.clearCache();
  });

  const insert = (login: string, role: string | null) => connection.executeOnDb(`INSERT INTO dialect_users (Login, Role) VALUES (?, ?)`, [login, role], QueryContext.Insert);

  const select = async (build: (qb: SelectQueryBuilder) => void) => {
    const qb = connection.Container.resolve<SelectQueryBuilder>(SelectQueryBuilder, [connection]);
    qb.select('*').from('dialect_users');
    build(qb);

    const compiled = qb.toDB() as any;
    return (await connection.executeOnDb(compiled.expression, compiled.bindings, QueryContext.Select)) as any[];
  };

  describe('registrations', () => {
    it('resolves set membership to the sqlite implementation', () => {
      expect(connection.Container.resolve<InSetStatement>(InSetStatement, ['Role', ['admin'], false, undefined])).to.be.instanceOf(SqliteInSetStatement);
    });

    it('resolves a quoter, because the shared driver no longer registers one', () => {
      const quoter = connection.Container.resolve<IdentifierQuoter>(IdentifierQuoter);

      expect(quoter.quote('Role')).to.eq('`Role`');
      expect(quoter.quoteQualified('db.users')).to.eq('`db`.`users`');
    });

    /**
     * SQLite has no `CREATE TABLE ... LIKE`, so this driver deliberately registers no
     * clone compiler. It used to inherit MySQL's and send it to SQLite; failing here,
     * by name, is the point of registering only what a dialect can actually do.
     */
    it('leaves an unsupported feature unregistered rather than inheriting MySQL SQL', () => {
      expect(connection.Container.hasRegistered('TableCloneQueryCompiler')).to.eq(false);
    });
  });

  describe('set membership', () => {
    it('compiles to instr, not to FIND_IN_SET', () => {
      const statement = connection.Container.resolve<InSetStatement>(InSetStatement, ['Role', ['admin'], false, undefined]);
      const { Statements, Bindings } = statement.build();

      expect(Statements[0]).to.contain('instr(');
      expect(Statements[0]).to.not.contain('FIND_IN_SET');
      expect(Bindings).to.deep.eq([',admin,']);
    });

    it('finds a member wherever it sits in the column', async () => {
      await insert('only', 'admin');
      await insert('first', 'admin,user');
      await insert('last', 'user,admin');
      await insert('middle', 'user,admin,guest');
      await insert('absent', 'user,guest');

      const rows = await select((qb) => qb.whereInSet('Role', ['admin']));

      expect(rows.map((r) => r.Login).sort()).to.deep.eq(['first', 'last', 'middle', 'only']);
    });

    it('does not match a value that is only a prefix of a member', async () => {
      await insert('similar', 'administrator');
      await insert('real', 'admin');

      const rows = await select((qb) => qb.whereInSet('Role', ['admin']));

      expect(rows.map((r) => r.Login)).to.deep.eq(['real']);
    });

    it('matches any of several values', async () => {
      await insert('a', 'admin');
      await insert('b', 'guest');
      await insert('c', 'user,guest');

      const rows = await select((qb) => qb.whereInSet('Role', ['admin', 'user']));

      expect(rows.map((r) => r.Login).sort()).to.deep.eq(['a', 'c']);
    });

    it('excludes members with whereNotInSet', async () => {
      await insert('a', 'admin');
      await insert('b', 'user');
      await insert('c', 'user,admin');

      const rows = await select((qb) => qb.whereNotInSet('Role', ['admin']));

      expect(rows.map((r) => r.Login)).to.deep.eq(['b']);
    });

    it('treats a NULL column as a member of nothing', async () => {
      await insert('nulled', null);

      const inSet = await select((qb) => qb.whereInSet('Role', ['admin']));
      const notInSet = await select((qb) => qb.whereNotInSet('Role', ['admin']));

      expect(inSet).to.have.lengthOf(0);
      expect(notInSet.map((r) => r.Login), 'a row with no roles is not in the set, so it IS in the negation').to.deep.eq(['nulled']);
    });

    it('refuses a value containing the set delimiter', () => {
      const statement = connection.Container.resolve<InSetStatement>(InSetStatement, ['Role', ['admin,user'], false, undefined]);

      expect(() => statement.build()).to.throw(InvalidArgument, /delimiter/);
    });
  });
});
