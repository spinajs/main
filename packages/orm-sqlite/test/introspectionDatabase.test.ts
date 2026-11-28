import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, createQuery, DefaultMigrationService, InsertBehaviour, InsertQueryBuilder, introspectSchema, Model, ModelBase, Orm, Primary, QueryContext, WriteObserver } from '@spinajs/orm';
import type { CaptureInterest, CapturedWrite, OrmMigrationService, RowChange, WriteStatement } from '@spinajs/orm';
import { expect } from 'chai';
import _ from 'lodash';
import 'mocha';
import sinon from 'sinon';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

class AttachedConf extends ConnectionConf {
  public async resolve(): Promise<void> {
    await super.resolve();
    _.set(this.Config, 'db.Connections[0].Database', 's');
  }
}

// `sqlite-shared` names `s`; its writes run on `sqlite`, which has `s` attached and no Database of its own.
class SharedServerConf extends ConnectionConf {
  public async resolve(): Promise<void> {
    await super.resolve();
    _.set(this.Config, 'db.Connections[0].SharedServer', 'memory');
    _.set(this.Config, 'db.Connections[1]', { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite-shared', SharedServer: 'memory', Database: 's' });
  }
}

@Connection('sqlite')
@Model('p_up')
class PUp extends ModelBase<PUp> {
  @Primary()
  public Id: number;

  public Code: string;

  public Name: string;
}

const writes: CapturedWrite[] = [];

class PUpObserver extends WriteObserver {
  interest({ model }: WriteStatement): CaptureInterest | undefined {
    return model === PUp ? { columns: '*', transactional: true } : undefined;
  }

  async observe(write: CapturedWrite): Promise<void> {
    writes.push(write);
    return Promise.resolve();
  }
}

const sqlite = () => db().Connections.get('sqlite') as SqliteOrmDriver;
const run = (stmt: string, params: unknown[] = []) => sqlite().executeOnDb(stmt, params, QueryContext.Schema);
const rowsOf = (stmt: string) => sqlite().executeOnDb(stmt, [], QueryContext.Select) as Promise<Array<Record<string, unknown>>>;

/** The statements the driver ran during `fn`. */
async function statementsDuring(fn: () => Promise<unknown>): Promise<string[]> {
  const driver = sqlite();
  const original = driver.executeOnDb.bind(driver);
  const seen: string[] = [];
  const stub = sinon.stub(driver, 'executeOnDb').callsFake((stmt: string, params: unknown[], context: QueryContext) => {
    seen.push(stmt);
    return original(stmt, params, context);
  });
  try {
    await fn();
  } finally {
    stub.restore();
  }
  return seen;
}

const UNIQUE_CODE = (schema: string) => [
  `CREATE TABLE ${schema}.p_up (Id INTEGER PRIMARY KEY, Code TEXT UNIQUE, Name TEXT)`,
  `CREATE TABLE ${schema}.p_child (Id INTEGER PRIMARY KEY, ParentId INTEGER REFERENCES p_up (Id) ON DELETE CASCADE, Note TEXT)`,
];
// Another column set and no unique index or foreign key: what a read of `main` reports.
const PLAIN = (schema: string) => [`CREATE TABLE ${schema}.p_up (Id INTEGER PRIMARY KEY, Code TEXT, Name TEXT, Extra TEXT)`, `CREATE TABLE ${schema}.p_child (Id INTEGER PRIMARY KEY, ParentId INTEGER, Note TEXT)`];
const MAIN_UNIQUE = (schema: string) => [`CREATE TABLE ${schema}.p_up (Id INTEGER PRIMARY KEY, Code TEXT UNIQUE, Name TEXT, Extra TEXT)`];
const S_PLAIN = (schema: string) => [`CREATE TABLE ${schema}.p_up (Id INTEGER PRIMARY KEY, Code TEXT, Name TEXT)`];

interface Layout {
  readonly s: (schema: string) => string[];
  readonly main?: (schema: string) => string[];
}

const S_UNIQUE_MAIN_PLAIN: Layout = { s: UNIQUE_CODE, main: PLAIN };
const S_UNIQUE_ONLY: Layout = { s: UNIQUE_CODE };
const S_PLAIN_MAIN_UNIQUE: Layout = { s: S_PLAIN, main: MAIN_UNIQUE };
const S_PLAIN_ONLY: Layout = { s: S_PLAIN };

const byId = (rows: readonly RowChange[]) => [...rows].sort((a, b) => Number(a.id) - Number(b.id));
const rowsOfLastWrite = () => byId(writes.at(-1)?.rows ?? []);

describe('sqlite introspection of a table in an attached database', function () {
  this.timeout(60000);

  let sandbox: string;
  let files = 0;

  before(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'spinajs-introspection-db-'));
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(PUpObserver).as(WriteObserver);
  });

  after(() => {
    DI.unregister(PUpObserver);
    rmSync(sandbox, { recursive: true, force: true });
  });

  async function boot(conf: typeof ConnectionConf, layout: Layout) {
    DI.register(conf).as(Configuration);
    await DI.resolve(Orm);
    files += 1;
    await run('ATTACH DATABASE ? AS s', [join(sandbox, `s-${files}.sqlite`)]);
    for (const ddl of layout.s('s')) await run(ddl);
    for (const ddl of layout.main?.('main') ?? []) await run(ddl);
    await run("INSERT INTO s.p_up (Id, Code, Name) VALUES (1, 'a', 'a')");
    await db().reloadTableInfo();
    writes.length = 0;
  }

  async function shutdown(conf: typeof ConnectionConf) {
    await run('DETACH DATABASE s');
    DI.unregister(Configuration, conf);
    DI.clearCache();
  }

  describe('the driver, asked for a schema', () => {
    beforeEach(() => boot(ConnectionConf, S_UNIQUE_MAIN_PLAIN));
    afterEach(() => shutdown(ConnectionConf));

    it('tableInfo reads the columns, keys and Unique flags of that schema', async () => {
      const columns = await sqlite().tableInfo('p_up', 's');

      expect(columns.map((c) => [c.Name, c.PrimaryKey, c.Unique])).to.deep.equal([
        ['Id', true, false],
        ['Code', false, true],
        ['Name', false, false],
      ]);
      expect(columns.every((c) => c.Schema === 's')).to.equal(true);
    });

    it('tableInfo reads the foreign keys of that schema', async () => {
      const columns = await sqlite().tableInfo('p_child', 's');

      expect(columns.find((c) => c.Name === 'ParentId')?.ForeignKeyDescription).to.deep.equal({ From: 'ParentId', Table: 'p_up', To: 'Id' });
    });

    it('tableIndexes reads the indexes of that schema', async () => {
      expect(await sqlite().tableIndexes('p_up', 's')).to.deep.equal([
        { name: 'PRIMARY', columns: ['Id'], unique: true, primary: true },
        { name: 'sqlite_autoindex_p_up_1', columns: ['Code'], unique: true, primary: false },
      ]);
    });

    it('tableForeignKeys reads the foreign keys of that schema', async () => {
      expect(await sqlite().tableForeignKeys('p_child', 's')).to.deep.equal([{ name: 'fk_p_child_0', column: 'ParentId', table: 'p_up', references: 'Id', onDelete: 'CASCADE', onUpdate: 'NO ACTION' }]);
    });

    it('reads through the pragmas of that schema', async () => {
      expect(await statementsDuring(() => sqlite().tableInfo('p_up', 's'))).to.deep.equal([
        'SELECT 1 FROM pragma_database_list WHERE name = ? COLLATE NOCASE',
        'PRAGMA "s".table_info("p_up");',
        'PRAGMA "s".index_list("p_up")',
        'PRAGMA "s".index_info("sqlite_autoindex_p_up_1")',
        'PRAGMA "s".foreign_key_list("p_up")',
      ]);
    });

    // Both automatic indexes are named sqlite_autoindex_p_up_1; an unqualified index_info finds main's first.
    it('reads the columns of the index of that schema when main has an index of the same name', async () => {
      await run('DROP TABLE main.p_up');
      await run('CREATE TABLE main.p_up (Id INTEGER PRIMARY KEY, Code TEXT, Name TEXT UNIQUE)');

      expect((await sqlite().tableIndexes('p_up', 's')).filter((i) => !i.primary).map((i) => [i.name, i.columns])).to.deep.equal([['sqlite_autoindex_p_up_1', ['Code']]]);
      expect((await sqlite().tableInfo('p_up', 's')).filter((c) => c.Unique).map((c) => c.Name)).to.deep.equal(['Code']);
    });

    it('reads an attached schema named in another case', async () => {
      expect((await sqlite().tableInfo('p_up', 'S')).map((c) => [c.Name, c.Unique])).to.deep.equal([
        ['Id', false],
        ['Code', true],
        ['Name', false],
      ]);
      expect((await sqlite().tableIndexes('p_up', 'S')).map((i) => i.columns)).to.deep.equal([['Id'], ['Code']]);
      expect((await sqlite().tableForeignKeys('p_child', 'S')).map((k) => k.column)).to.deep.equal(['ParentId']);
    });

    it('reads a schema that is not attached as holding no table', async () => {
      expect(await sqlite().tableInfo('p_up', 'nope')).to.equal(null);
      expect(await sqlite().tableIndexes('p_up', 'nope')).to.deep.equal([]);
      expect(await sqlite().tableForeignKeys('p_child', 'nope')).to.deep.equal([]);
    });

    it('reads main when main is named', async () => {
      expect((await sqlite().tableInfo('p_up', 'main')).map((c) => [c.Name, c.Unique])).to.deep.equal([
        ['Id', false],
        ['Code', false],
        ['Name', false],
        ['Extra', false],
      ]);
      expect(await sqlite().tableIndexes('p_up', 'main')).to.deep.equal([{ name: 'PRIMARY', columns: ['Id'], unique: true, primary: true }]);
      expect(await sqlite().tableForeignKeys('p_child', 'main')).to.deep.equal([]);
    });

    it('reads temp when temp is named', async () => {
      await run('CREATE TEMP TABLE p_tmp (Id INTEGER PRIMARY KEY, Code TEXT UNIQUE)');

      expect((await sqlite().tableInfo('p_tmp', 'temp')).map((c) => [c.Name, c.Unique])).to.deep.equal([
        ['Id', false],
        ['Code', true],
      ]);
      expect((await sqlite().tableIndexes('p_tmp', 'temp')).map((i) => i.columns)).to.deep.equal([['Id'], ['Code']]);
    });

    it('quotes a schema and a table name that hold a quote, a space and a semicolon', async () => {
      const schema = 's "q"; x';
      const table = 't "q"; DROP TABLE p_up; --';
      const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
      files += 1;
      await run(`ATTACH DATABASE ? AS ${quote(schema)}`, [join(sandbox, `s-${files}.sqlite`)]);
      try {
        await run(`CREATE TABLE ${quote(schema)}.${quote(table)} (Id INTEGER PRIMARY KEY, Code TEXT UNIQUE, ParentId INTEGER REFERENCES ${quote(table)} (Id))`);

        expect((await sqlite().tableInfo(table, schema)).map((c) => [c.Name, c.Unique])).to.deep.equal([
          ['Id', false],
          ['Code', true],
          ['ParentId', false],
        ]);
        expect((await sqlite().tableIndexes(table, schema)).map((i) => i.columns)).to.deep.equal([['Id'], ['Code']]);
        expect((await sqlite().tableForeignKeys(table, schema)).map((k) => [k.column, k.table])).to.deep.equal([['ParentId', table]]);
        expect(await rowsOf("SELECT name FROM main.sqlite_master WHERE name = 'p_up'")).to.have.length(1);
        expect(await rowsOf("SELECT name FROM s.sqlite_master WHERE name = 'p_up'")).to.have.length(1);
      } finally {
        await run(`DETACH DATABASE ${quote(schema)}`);
      }
    });
  });

  describe('the driver, asked for no schema', () => {
    beforeEach(async () => {
      await boot(AttachedConf, S_UNIQUE_MAIN_PLAIN);
      await run('CREATE TABLE main.p_pin (Id INTEGER PRIMARY KEY, Code TEXT UNIQUE, ParentId INTEGER REFERENCES p_pin (Id))');
    });
    afterEach(() => shutdown(AttachedConf));

    // An unqualified probe reads where an unqualified CREATE TABLE lands, as the migration table's probe expects.
    it('tableInfo reads the unqualified table with the same pragmas, Database or not', async () => {
      let columns: Awaited<ReturnType<SqliteOrmDriver['tableInfo']>> = [];
      const statements = await statementsDuring(async () => (columns = await sqlite().tableInfo('p_pin')));

      expect(statements).to.deep.equal(['PRAGMA table_info("p_pin");', 'PRAGMA index_list("p_pin")', 'PRAGMA index_info("sqlite_autoindex_p_pin_1")', 'PRAGMA foreign_key_list("p_pin")']);
      expect(columns.map((c) => [c.Name, c.Unique])).to.deep.equal([
        ['Id', false],
        ['Code', true],
        ['ParentId', false],
      ]);
      expect(columns.every((c) => c.Schema === 's')).to.equal(true);
    });

    it('tableIndexes reads the unqualified table with the same pragmas', async () => {
      let indexes: Awaited<ReturnType<SqliteOrmDriver['tableIndexes']>> = [];
      const statements = await statementsDuring(async () => (indexes = await sqlite().tableIndexes('p_pin')));

      expect(statements).to.deep.equal(['PRAGMA index_list("p_pin")', 'PRAGMA index_info("sqlite_autoindex_p_pin_1")', 'PRAGMA table_info("p_pin")']);
      expect(indexes.map((i) => i.columns)).to.deep.equal([['Id'], ['Code']]);
    });

    it('tableForeignKeys reads the unqualified table with the same pragma', async () => {
      let keys: Awaited<ReturnType<SqliteOrmDriver['tableForeignKeys']>> = [];
      const statements = await statementsDuring(async () => (keys = await sqlite().tableForeignKeys('p_pin')));

      expect(statements).to.deep.equal(['PRAGMA foreign_key_list("p_pin")']);
      expect(keys.map((k) => [k.column, k.table])).to.deep.equal([['ParentId', 'p_pin']]);
    });

    it('reads p_up of main, not of s', async () => {
      expect((await sqlite().tableInfo('p_up')).map((c) => c.Name)).to.deep.equal(['Id', 'Code', 'Name', 'Extra']);
    });

    it('keeps reading the migration table where its unqualified CREATE TABLE put it', async () => {
      const service = await sqlite().Container.resolve<OrmMigrationService>(DefaultMigrationService, [sqlite()]);
      await service.ensureStorage();
      await service.ensureStorage();

      expect(await rowsOf("SELECT name FROM main.sqlite_master WHERE name = 'orm_migrations'")).to.have.length(1);
    });
  });

  // `S_UNIQUE_ONLY` and `S_PLAIN_ONLY` are the controls: with no table in main nothing can be read from it.
  for (const [layout, label] of [
    [S_UNIQUE_MAIN_PLAIN, 'in main and s'],
    [S_UNIQUE_ONLY, 'in s only'],
  ] as const) {
    describe(`a model on a connection with Database s, s with UNIQUE(Code), table ${label}`, () => {
      beforeEach(() => boot(AttachedConf, layout));
      afterEach(() => shutdown(AttachedConf));

      it('reflects the columns, primary key and Unique flags of s', () => {
        const descriptor = PUp.getModelDescriptor();

        expect(descriptor.PrimaryKey).to.deep.equal(['Id']);
        expect(descriptor.Columns.map((c) => [c.Name, c.PrimaryKey, c.Unique])).to.deep.equal([
          ['Id', true, false],
          ['Code', false, true],
          ['Name', false, false],
        ]);
      });

      it('InsertOrUpdate updates the row of s that holds the code', async () => {
        await PUp.insert({ Id: 9, Code: 'a', Name: 'u' }, InsertBehaviour.InsertOrUpdate);

        expect(await rowsOf('SELECT * FROM s.p_up ORDER BY Id')).to.deep.equal([{ Id: 1, Code: 'a', Name: 'u' }]);
        expect(rowsOfLastWrite()).to.deep.equal([{ id: '1', before: { Id: 1, Code: 'a', Name: 'a' }, after: { Id: 1, Code: 'a', Name: 'u' } }]);
      });

      it('a replace captures the row it deleted and the row it inserted', async () => {
        await PUp.insert({ Id: 9, Code: 'a', Name: 'r' }, InsertBehaviour.InsertOrReplace);

        expect(await rowsOf('SELECT * FROM s.p_up ORDER BY Id')).to.deep.equal([{ Id: 9, Code: 'a', Name: 'r' }]);
        expect(rowsOfLastWrite()).to.deep.equal([
          { id: '1', before: { Id: 1, Code: 'a', Name: 'a' }, after: undefined },
          { id: '9', before: undefined, after: { Id: 9, Code: 'a', Name: 'r' } },
        ]);
      });

      it('an ignored insert captures the conflicting row of s unchanged', async () => {
        await PUp.insert({ Id: 9, Code: 'a', Name: 'i' }, InsertBehaviour.InsertOrIgnore);

        expect(await rowsOf('SELECT * FROM s.p_up ORDER BY Id')).to.deep.equal([{ Id: 1, Code: 'a', Name: 'a' }]);
        expect(rowsOfLastWrite()).to.deep.equal([{ id: '1', before: { Id: 1, Code: 'a', Name: 'a' }, after: { Id: 1, Code: 'a', Name: 'a' } }]);
      });
    });
  }

  for (const [layout, label] of [
    [S_PLAIN_MAIN_UNIQUE, 'in main and s'],
    [S_PLAIN_ONLY, 'in s only'],
  ] as const) {
    describe(`a model on a connection with Database s, main with UNIQUE(Code), table ${label}`, () => {
      beforeEach(() => boot(AttachedConf, layout));
      afterEach(() => shutdown(AttachedConf));

      it('reflects Code as not unique', () => {
        expect(PUp.getModelDescriptor().Columns.find((c) => c.Name === 'Code')?.Unique).to.equal(false);
      });

      it('a replace captures only the row it inserted', async () => {
        await PUp.insert({ Id: 9, Code: 'a', Name: 'r' }, InsertBehaviour.InsertOrReplace);

        expect(rowsOfLastWrite()).to.deep.equal([{ id: '9', before: undefined, after: { Id: 9, Code: 'a', Name: 'r' } }]);
      });

      it('an ignored insert captures only the row it inserted', async () => {
        await PUp.insert({ Id: 9, Code: 'a', Name: 'i' }, InsertBehaviour.InsertOrIgnore);

        expect(await rowsOf('SELECT Id FROM s.p_up ORDER BY Id')).to.deep.equal([{ Id: 1 }, { Id: 9 }]);
        expect(rowsOfLastWrite()).to.deep.equal([{ id: '9', before: undefined, after: { Id: 9, Code: 'a', Name: 'i' } }]);
      });
    });
  }

  describe('an upsert run through another connection of the server, s with UNIQUE(Code), table in main and s', () => {
    beforeEach(() => boot(SharedServerConf, S_UNIQUE_MAIN_PLAIN));
    afterEach(() => shutdown(SharedServerConf));

    it("a replace captures the row it deleted in the database of the model's connection", async () => {
      const descriptor = PUp.getModelDescriptor();
      descriptor.Connection = 'sqlite-shared';
      try {
        const { query } = createQuery(PUp, InsertQueryBuilder, true, sqlite());
        query.orReplace();
        query.values({ Id: 9, Code: 'a', Name: 'r' });
        await query;
      } finally {
        descriptor.Connection = 'sqlite';
      }

      expect(await rowsOf('SELECT * FROM s.p_up ORDER BY Id')).to.deep.equal([{ Id: 9, Code: 'a', Name: 'r' }]);
      expect(rowsOfLastWrite()).to.deep.equal([
        { id: '1', before: { Id: 1, Code: 'a', Name: 'a' }, after: undefined },
        { id: '9', before: undefined, after: { Id: 9, Code: 'a', Name: 'r' } },
      ]);
    });
  });

  describe('the schema diff introspection on a connection with Database s, table in main and s', () => {
    beforeEach(() => boot(AttachedConf, S_UNIQUE_MAIN_PLAIN));
    afterEach(() => shutdown(AttachedConf));

    const hasRows = async () => (await introspectSchema(sqlite(), ['p_up'])).extras.get('p_up')?.hasRows;

    // Read as empty, a NOT NULL column without a default would be added as a live step and fail on these rows.
    it('reads the rows of s.p_up when main.p_up is empty', async () => {
      expect(await rowsOf('SELECT Id FROM main.p_up')).to.deep.equal([]);

      expect(await hasRows()).to.equal(true);
    });

    it('reads s.p_up as empty when only main.p_up has rows', async () => {
      await run('DELETE FROM s.p_up');
      await run("INSERT INTO main.p_up (Id, Code, Name) VALUES (1, 'a', 'a')");

      expect(await hasRows()).to.equal(false);
    });

    it('probes the rows with a select qualified by s', async () => {
      expect((await statementsDuring(hasRows)).filter((stmt) => stmt.startsWith('SELECT *'))).to.deep.equal(['SELECT * FROM `s`.`p_up` LIMIT ?']);
    });
  });

  describe('the schema diff introspection on a connection without Database, table in main and s', () => {
    beforeEach(() => boot(ConnectionConf, S_UNIQUE_MAIN_PLAIN));
    afterEach(() => shutdown(ConnectionConf));

    it('probes the rows of the unqualified table with an unqualified select', async () => {
      let rows: boolean | undefined;
      const statements = await statementsDuring(async () => (rows = (await introspectSchema(sqlite(), ['p_up'])).extras.get('p_up')?.hasRows));

      expect(statements.filter((stmt) => stmt.startsWith('SELECT *'))).to.deep.equal(['SELECT * FROM `p_up` LIMIT ?']);
      expect(rows).to.equal(false);
    });
  });
});
