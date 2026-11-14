import { Configuration } from '@spinajs/configuration';
import { DI, Injectable, NewInstance } from '@spinajs/di';
import { NotSupported } from '@spinajs/exceptions';
import { ConstraintViolation, OrmDriver, QueryContext } from '@spinajs/orm';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sinon from 'sinon';
import sqlite3 from 'sqlite3';
import '@spinajs/log';
import { SqliteOrmDriver } from './../src/index.js';
import { ConnectionConf } from './common.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

const DB_FILE = join(tmpdir(), `spinajs-foreign-keys-${process.pid}.sqlite`);

function removeDbFiles() {
  [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`, `${DB_FILE}-journal`].forEach((f) => {
    if (existsSync(f)) {
      unlinkSync(f);
    }
  });
}

type Outcome = { ok: true } | { ok: false; error: unknown };

/** Runs an orphan insert the moment the writer is open, before connect() returns. */
@Injectable('orm-driver-sqlite-fk-probe')
@NewInstance()
class EarlyWriteDriver extends SqliteOrmDriver {
  public Outcomes: Outcome[] = [];

  protected async openReadPool(filename: string): Promise<void> {
    try {
      await this.executeOnDb('INSERT INTO fk_child (ParentId) VALUES (?)', [999], QueryContext.Insert);
      this.Outcomes.push({ ok: true });
    } catch (error) {
      this.Outcomes.push({ ok: false, error });
    }

    await super.openReadPool(filename);
  }
}

/** The workaround applications shipped before the option existed. */
@Injectable('orm-driver-sqlite-fk-subclass')
@NewInstance()
class PragmaAfterConnectDriver extends SqliteOrmDriver {
  private foreignKeysOn: Promise<void> | null = null;

  public async connect(): Promise<OrmDriver> {
    let release!: () => void;
    this.foreignKeysOn = new Promise<void>((resolve) => (release = resolve));
    try {
      await super.connect();
      await new Promise<void>((resolve, reject) => this.Db.exec('PRAGMA foreign_keys = ON', (error) => (error ? reject(error) : resolve())));
    } finally {
      this.foreignKeysOn = null;
      release();
    }
    return this;
  }

  protected runStatement(stmt: string, params: unknown[], queryContext: QueryContext): Promise<unknown> {
    const gate = this.foreignKeysOn;
    return gate ? gate.then(() => super.runStatement(stmt, params, queryContext)) : super.runStatement(stmt, params, queryContext);
  }
}

async function open<T extends SqliteOrmDriver = SqliteOrmDriver>(options: Record<string, unknown>, token = 'orm-driver-sqlite'): Promise<T> {
  const d = await DI.resolve<T>(token, [{ Driver: token, Name: 'fk', Filename: DB_FILE, ...options }]);
  await d.connect();
  return d;
}

async function readForeignKeys(d: SqliteOrmDriver): Promise<number> {
  const [row] = (await d.executeOnDb('PRAGMA foreign_keys', [], QueryContext.Select)) as { foreign_keys: number }[];
  return row.foreign_keys;
}

// A plain select would run on a read handle, whose pragma is always 0; a transaction stays on the writer.
async function foreignKeys(d: SqliteOrmDriver): Promise<number> {
  let value = -1;
  await d.transaction(async () => {
    value = await readForeignKeys(d);
  });
  return value;
}

function orphan(d: SqliteOrmDriver) {
  return d.executeOnDb('INSERT INTO fk_child (ParentId) VALUES (?)', [999], QueryContext.Insert);
}

function expectForeignKeyError(error: unknown) {
  expect(error).to.be.instanceOf(ConstraintViolation);
  expect((error as ConstraintViolation).kind).to.eq('foreign_key');
}

async function failure(work: PromiseLike<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (err) {
    return err;
  }

  throw new Error('expected the statement to fail');
}

describe('Sqlite - ForeignKeys connection option', function () {
  this.timeout(20000);

  const opened: SqliteOrmDriver[] = [];

  async function driver<T extends SqliteOrmDriver = SqliteOrmDriver>(options: Record<string, unknown>, token?: string): Promise<T> {
    const d = await open<T>(options, token);
    opened.push(d);
    return d;
  }

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(EarlyWriteDriver).as('orm-driver-sqlite-fk-probe');
    DI.register(PragmaAfterConnectDriver).as('orm-driver-sqlite-fk-subclass');
  });

  beforeEach(async () => {
    removeDbFiles();

    const setup = await open({});
    await setup.executeOnDb('CREATE TABLE fk_parent (Id INTEGER PRIMARY KEY, Name TEXT); CREATE TABLE fk_child (Id INTEGER PRIMARY KEY, ParentId INTEGER NOT NULL REFERENCES fk_parent (Id))', [], QueryContext.Schema);
    await setup.disconnect();
  });

  afterEach(async () => {
    sinon.restore();
    await Promise.all(opened.splice(0).map((d) => d.disconnect()));
    removeDbFiles();
  });

  it('switches foreign keys on for the writer', async () => {
    const d = await driver({ ForeignKeys: true });

    expect(await foreignKeys(d)).to.eq(1);
    expect(await readForeignKeys(d), 'read handles are opened read-only and never get the pragma').to.eq(0);
    expectForeignKeyError(await failure(orphan(d)));
  });

  it('leaves them off without the option', async () => {
    const d = await driver({});

    expect(await foreignKeys(d)).to.eq(0);
    await expect(orphan(d)).to.be.fulfilled;
  });

  it('enforces them on a statement run as soon as the writer opens, on connect and on reconnect', async () => {
    const d = await driver<EarlyWriteDriver>({ ForeignKeys: true }, 'orm-driver-sqlite-fk-probe');
    await d.connect();

    expect(d.Outcomes).to.have.length(2);
    d.Outcomes.forEach((o) => {
      expect(o.ok, 'the orphan row was stored before the pragma ran').to.eq(false);
      expectForeignKeyError((o as { error: unknown }).error);
    });
    expect(await foreignKeys(d)).to.eq(1);
  });

  it('keeps them on after a reconnect', async () => {
    const d = await driver({ ForeignKeys: true });
    await d.connect();

    expect(await foreignKeys(d)).to.eq(1);
    expectForeignKeyError(await failure(orphan(d)));
  });

  it('rejects connect and keeps no handle when the build ignores the pragma', async () => {
    const get = sinon.stub(sqlite3.Database.prototype, 'get').callThrough();
    get.withArgs('PRAGMA foreign_keys').callsFake(function (this: sqlite3.Database, _sql: string, ...rest: unknown[]) {
      (rest[rest.length - 1] as (err: Error | null, row: unknown) => void)(null, { foreign_keys: 0 });
      return this;
    });

    const d = await DI.resolve<SqliteOrmDriver>('orm-driver-sqlite', [{ Driver: 'orm-driver-sqlite', Name: 'fk', Filename: DB_FILE, ForeignKeys: true }]);
    opened.push(d);

    await expect(d.connect()).to.be.rejectedWith(/foreign keys/);
    expect(await d.ping()).to.eq(false);
  });

  it('keeps a subclass that runs the pragma after super.connect() working', async () => {
    const d = await driver<PragmaAfterConnectDriver>({}, 'orm-driver-sqlite-fk-subclass');
    await d.connect();

    expect(await foreignKeys(d)).to.eq(1);
    expectForeignKeyError(await failure(orphan(d)));
  });

  describe('schema changes', () => {
    it('refuses to modify a referenced table', async () => {
      const d = await driver({ ForeignKeys: true });

      await expect(
        d.schema().alterTable('fk_parent', (table) => {
          table.string('Name', 64).modify();
        }),
      ).to.be.rejectedWith(NotSupported, /fk_child references it/);
    });

    it('rejects dropping a referenced table that still has referencing rows', async () => {
      const d = await driver({ ForeignKeys: true });
      await d.executeOnDb('INSERT INTO fk_parent (Id) VALUES (1)', [], QueryContext.Insert);
      await d.executeOnDb('INSERT INTO fk_child (ParentId) VALUES (1)', [], QueryContext.Insert);

      expectForeignKeyError(await failure(d.schema().dropTable('fk_parent')));
    });

    it('deletes the referencing rows of an ON DELETE CASCADE key when the referenced table is dropped', async () => {
      const d = await driver({ ForeignKeys: true });
      await d.executeOnDb('CREATE TABLE fk_cascade (Id INTEGER PRIMARY KEY, ParentId INTEGER NOT NULL REFERENCES fk_parent (Id) ON DELETE CASCADE)', [], QueryContext.Schema);
      await d.executeOnDb('DROP TABLE fk_child', [], QueryContext.Schema);
      await d.executeOnDb('INSERT INTO fk_parent (Id) VALUES (1)', [], QueryContext.Insert);
      await d.executeOnDb('INSERT INTO fk_cascade (ParentId) VALUES (1)', [], QueryContext.Insert);

      await d.schema().dropTable('fk_parent');

      expect(await d.executeOnDb('SELECT * FROM fk_cascade', [], QueryContext.Select)).to.deep.eq([]);
    });

    it('cannot switch the pragma inside a transaction', async () => {
      const d = await driver({ ForeignKeys: true });

      await d.transaction(async () => {
        await d.executeOnDb('PRAGMA foreign_keys = OFF', [], QueryContext.Schema);
        expect(await readForeignKeys(d)).to.eq(1);
      });
    });

    it('modifies a referenced table with the pragma switched off outside a transaction', async () => {
      const d = await driver({ ForeignKeys: true });

      await d.executeOnDb('PRAGMA foreign_keys = OFF', [], QueryContext.Schema);
      await d.schema().alterTable('fk_parent', (table) => {
        table.string('Name', 64).modify();
      });
      await d.executeOnDb('PRAGMA foreign_keys = ON', [], QueryContext.Schema);

      expect(await d.executeOnDb('PRAGMA foreign_key_check', [], QueryContext.Select)).to.deep.eq([]);
      expectForeignKeyError(await failure(orphan(d)));
    });
  });
});
