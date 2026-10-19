/* eslint-disable @typescript-eslint/no-explicit-any */
import 'mocha';
import { expect } from 'chai';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument, MethodNotImplemented, NotSupported, ResourceDuplicated } from '@spinajs/exceptions';
import { IdentifierQuoter, InSetStatement, Orm, OrmException, QueryContext, RawQuery, SelectQueryBuilder } from '@spinajs/orm';

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

    it('refuses scheduled events, which sqlite does not have', () => {
      expect(connection.supportedFeatures().events).to.eq(false);
      expect(() => connection.schema().createEvent('e', (event) => event.every(1, 'DAY').do(new RawQuery('SELECT 1'))).toDB()).to.throw(MethodNotImplemented, 'orm-driver-sqlite has no native scheduled events');
      expect(() => connection.schema().dropEvent('e').toDB()).to.throw(MethodNotImplemented, 'orm-driver-sqlite has no native scheduled events');
    });
  });

  describe('identifier quoting in joins', () => {
    it('quotes the FROM table, the join tables and the ON keys with backticks', () => {
      const qb = connection.Container.resolve<SelectQueryBuilder>(SelectQueryBuilder, [connection]).select('*').from('users');
      const result = qb.leftJoin({ joinTable: 'adresses', joinTableAlias: 'adresses', joinTableForeignKey: 'addressId', sourceTablePrimaryKey: 'id', joinTableDriver: qb.Driver }).orderBy('name').toDB();

      expect((result as any).expression).to.equal('SELECT `$users$`.* FROM `users` as `$users$` LEFT JOIN `adresses` as `adresses` ON `$users$`.`id` = `adresses`.`addressId` ORDER BY `name` ASC');
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

  const failure = async (pending: PromiseLike<unknown>): Promise<any> => {
    try {
      await pending;
    } catch (err) {
      return err;
    }
    throw new Error('expected a rejection');
  };

  const rows = async (sql: string) => (await connection.executeOnDb(sql, [], QueryContext.Select)) as any[];

  describe('compiled statements', () => {
    beforeEach(async () => {
      await connection.executeOnDb(`CREATE TABLE prices (Sku TEXT PRIMARY KEY, Price INTEGER, Note TEXT)`, [], QueryContext.Schema);
      await connection.insert().into('prices').values([
        { Sku: 'A', Price: 1, Note: 'a' },
        { Sku: 'B', Price: 2, Note: 'b' },
      ]);
    });

    it('upserts every conflicting row with its own values', async () => {
      await connection
        .insert()
        .into('prices')
        .values([
          { Sku: 'A', Price: 10, Note: 'a' },
          { Sku: 'B', Price: 20, Note: 'b' },
        ])
        .onDuplicate('Sku')
        .update(['Price']);

      expect((await rows('SELECT Sku, Price FROM prices ORDER BY Sku')).map((r) => r.Price)).to.deep.eq([10, 20]);
    });

    it('keeps the existing row when an upsert names no columns to update', async () => {
      await connection.insert().into('prices').values({ Sku: 'A', Price: 10, Note: 'a' }).onDuplicate('Sku');

      expect((await rows(`SELECT Price FROM prices WHERE Sku = 'A'`))[0].Price).to.eq(1);
    });

    it('leaves out a column no row supplies, so the table default applies', async () => {
      await connection.insert().into('prices').values([{ Sku: 'C', Price: 3, Note: undefined }]);

      expect((await rows(`SELECT Note FROM prices WHERE Sku = 'C'`))[0].Note).to.eq(null);
    });

    it('skips rows without a limit', async () => {
      const result = await connection.select().from('prices').orderBy('Sku').skip(1);

      expect((result as any[]).map((r) => r.Sku)).to.deep.eq(['B']);
    });

    it('orders by every sort column', () => {
      const qb = connection.Container.resolve<SelectQueryBuilder>(SelectQueryBuilder, [connection]).select('*').from('prices').orderBy('Price').orderByDescending('Sku');

      expect((qb.toDB() as any).expression).to.match(/ORDER BY `Price` ASC, `Sku` DESC$/);
    });

    it('runs a RIGHT JOIN', async () => {
      const result = await connection
        .select()
        .from('dialect_users')
        .rightJoin({ joinTable: 'prices', joinTableAlias: 'prices', joinTableForeignKey: 'Sku', sourceTablePrimaryKey: 'Login', joinTableDriver: connection });

      expect(result as any[]).to.have.lengthOf(2);
    });
  });

  describe('schema', () => {
    it('creates a column with a charset, a comment and a string default holding a quote', async () => {
      await connection.schema().createTable('notes', (table) => {
        table.int('Id').primaryKey().autoIncrement();
        table.string('Body').notNull().charset('utf8').comment('free text').default().value("it's");
      });
      await connection.executeOnDb(`INSERT INTO notes DEFAULT VALUES`, [], QueryContext.Insert);

      expect((await rows('SELECT Body FROM notes'))[0].Body).to.eq("it's");
    });

    it('refuses history tracking instead of ignoring it', () => {
      expect(() =>
        connection
          .schema()
          .createTable('tracked', (table) => {
            table.int('Id').primaryKey();
            table.trackHistory();
          })
          .toDB(),
      ).to.throw(NotSupported);
    });

    it('runs every statement of a multi-statement raw schema query', async () => {
      await connection.executeOnDb(`CREATE TABLE raw_a (x); CREATE TABLE raw_b (x)`, [], QueryContext.Schema);

      expect(await rows(`SELECT name FROM sqlite_master WHERE name IN ('raw_a', 'raw_b') ORDER BY name`)).to.have.lengthOf(2);
    });

    it('keeps the sqlite3 error of a failed schema statement', async () => {
      const err = await failure(connection.executeOnDb(`CREATE TABLE dialect_users (x)`, [], QueryContext.Schema));

      expect(err).to.be.instanceOf(OrmException);
      expect(err.inner.code).to.eq('SQLITE_ERROR');
    });
  });

  describe('errors', () => {
    beforeEach(async () => {
      await connection.executeOnDb(`CREATE TABLE accounts (Id INTEGER PRIMARY KEY AUTOINCREMENT, Email TEXT NOT NULL UNIQUE)`, [], QueryContext.Schema);
      await connection.insert().into('accounts').values({ Email: 'a@b.c' });
    });

    it('reports a duplicate on a RETURNING insert as ResourceDuplicated', async () => {
      const err = await failure(connection.insert().into('accounts').values({ Email: 'a@b.c' }).returning(['Id']));

      expect(err).to.be.instanceOf(ResourceDuplicated);
      expect(err.inner.code).to.eq('SQLITE_CONSTRAINT');
    });

    it('does not report a NOT NULL violation as a duplicate', async () => {
      const err = await failure(connection.executeOnDb(`INSERT INTO accounts (Email) VALUES (NULL)`, [], QueryContext.Insert));

      expect(err).to.be.instanceOf(OrmException);
      expect(err).to.not.be.instanceOf(ResourceDuplicated);
    });
  });

  describe('transactions', () => {
    beforeEach(async () => {
      await connection.executeOnDb(`CREATE TABLE ledger (Amount INTEGER)`, [], QueryContext.Schema);
    });

    it('runs concurrent outermost transactions one after another', async () => {
      await Promise.all([
        connection.transaction(async () => connection.insert().into('ledger').values({ Amount: 10 })),
        connection.transaction(async () => connection.insert().into('ledger').values({ Amount: -10 })),
      ]);

      expect(await rows('SELECT Amount FROM ledger')).to.have.lengthOf(2);
    });

    it('keeps a write made outside an open transaction out of its rollback', async () => {
      let opened!: () => void;
      const outside = new Promise<void>((resolve) => (opened = resolve)).then(() => connection.executeOnDb(`INSERT INTO ledger (Amount) VALUES (2)`, [], QueryContext.Insert));

      await failure(
        connection.transaction(async () => {
          await connection.insert().into('ledger').values({ Amount: 1 });
          opened();
          await new Promise((resolve) => setTimeout(resolve, 20));
          throw new Error('rollback');
        }),
      );
      await outside;

      expect((await rows('SELECT Amount FROM ledger')).map((r) => r.Amount)).to.deep.eq([2]);
    });
  });

  describe('table reflection', () => {
    it('marks every single-column unique index, by exact column name, and quotes the table name', async () => {
      await connection.executeOnDb(`CREATE TABLE "user list" (Id INTEGER PRIMARY KEY, UserId INTEGER UNIQUE, Email TEXT UNIQUE)`, [], QueryContext.Schema);

      const columns = await connection.tableInfo('user list');

      expect(columns.filter((c) => c.Unique).map((c) => c.Name)).to.deep.eq(['UserId', 'Email']);
    });
  });

  it('fails the ping once the database handle no longer works', async () => {
    expect(await connection.ping()).to.eq(true);

    await new Promise((resolve) => (connection as any).Db.close(resolve));

    expect(await connection.ping()).to.eq(false);
  });
});
