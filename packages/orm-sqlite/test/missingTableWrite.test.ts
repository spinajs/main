import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Archived, Connection, extractModelDescriptor, Migration, Model, ModelBase, Orm, OrmDriver, OrmException, OrmMigration, Primary, QueryContext, resolveMigrationTool, Uuid } from '@spinajs/orm';
import { expect } from 'chai';
import _ from 'lodash';
import { DateTime } from 'luxon';
import 'mocha';
import sinon from 'sinon';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';
import { mergeArrays } from './util.js';

class AttachedConf extends ConnectionConf {
  public async resolve(): Promise<void> {
    await super.resolve();
    _.set(this.Config, 'db.Connections[0].Database', 's');
  }
}

let dbFile = '';

class FileConf extends ConnectionConf {
  public async resolve(): Promise<void> {
    await super.resolve();
    _.set(this.Config, 'db.Connections[0].Filename', dbFile);
  }
}

@Connection('sqlite')
@Model('r_dec')
class RDec extends ModelBase<RDec> {
  @Primary()
  public Id: number;

  @Uuid()
  public Ref: string;

  public Name: string;
}

@Connection('sqlite')
@Model('r_arch')
class RArch extends ModelBase<RArch> {
  @Primary()
  public Id: number;

  @Uuid()
  public Ref: string;

  @Archived()
  public ArchivedAt: DateTime;

  public Name: string;
}

const REFUSAL = 'model RDec: table r_dec on connection sqlite was missing when the Orm read it, so the model knows only its declared columns; create or attach the table, then call orm.reloadTableInfo()';
const TABLE = "(Id INTEGER PRIMARY KEY, Ref TEXT, Name TEXT NOT NULL DEFAULT 'dflt')";

const sqlite = () => db().Connections.get('sqlite') as SqliteOrmDriver;
const run = (stmt: string, params: unknown[] = []) => sqlite().executeOnDb(stmt, params, QueryContext.Schema);
const rowsOf = async (table: string) => (await sqlite().executeOnDb(`SELECT Id, Name FROM ${table} ORDER BY Id`, [], QueryContext.Select)) as Array<{ Id: number; Name: string }>;

async function rejection(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  return undefined;
}

/** The statements the driver ran during `fn`, the table reads left out. */
async function statementsDuring(fn: () => PromiseLike<unknown>): Promise<string[]> {
  const driver = sqlite();
  const original = driver.executeOnDb.bind(driver);
  const seen: string[] = [];
  const stub = sinon.stub(driver, 'executeOnDb').callsFake((stmt: string, params: unknown[], context: QueryContext) => {
    if (!/pragma/i.test(stmt)) seen.push(stmt);
    return original(stmt, params, context);
  });
  try {
    await fn();
  } finally {
    stub.restore();
  }
  return seen;
}

/** Every write path whose column list comes from the descriptor. */
const DESCRIPTOR_WRITES: Record<string, () => PromiseLike<unknown>> = {
  'a static insert': () => RDec.insert({ Id: 3, Ref: 'r', Name: 'given' }),
  'an instance insert': () => new RDec({ Id: 3, Ref: 'r', Name: 'given' }).insert(),
  'a bulk insert': () =>
    RDec.insert([
      { Id: 3, Ref: 'r', Name: 'given' },
      { Id: 4, Ref: 'q', Name: 'given2' },
    ]),
  'insertOrUpdate() of a model with a key': () => new RDec({ Id: 10, Ref: 'r', Name: 'upserted' }).insertOrUpdate(),
  'update() of a fetched model': async () => {
    const m = await RDec.where('Id', 10).first();
    m.Name = 'changed';
    await m.update();
  },
  'update(data) of a model with a key': () => new RDec({ Id: 10, Ref: 'seed', Name: 'seed' }).update({ Name: 'changed' }),
  'save()': () => new RDec({ Id: 3, Ref: 'r', Name: 'given' }).save(),
  'save() of a fetched model': async () => {
    const m = await RDec.where('Id', 10).first();
    m.Name = 'changed';
    await m.save();
  },
};

describe('sqlite: a write through a model whose table was missing when the Orm read it', function () {
  this.timeout(60000);

  let sandbox: string;
  let files = 0;
  let attached = false;

  before(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'spinajs-missing-table-write-'));
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  after(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  /** Boots with `s` not attached, so `r_dec` reads as missing; then attaches `s` and, with `create`, creates the table. */
  async function boot(options: { attach: boolean; create: boolean }) {
    DI.register(AttachedConf).as(Configuration);
    await DI.resolve(Orm);
    attached = options.attach;
    if (options.attach) {
      files += 1;
      await run('ATTACH DATABASE ? AS s', [join(sandbox, `s-${files}.sqlite`)]);
    }
    if (options.create) {
      await run(`CREATE TABLE s.r_dec ${TABLE}`);
      await run("INSERT INTO s.r_dec (Id, Ref, Name) VALUES (10, 'seed', 'seed')");
    }
  }

  async function shutdown() {
    if (attached) await run('DETACH DATABASE s');
    DI.unregister(Configuration, AttachedConf);
    DI.clearCache();
  }

  describe('the table appeared after the read', () => {
    beforeEach(() => boot({ attach: true, create: true }));
    afterEach(() => shutdown());

    it('refuses a static insert instead of storing { Id: 3, Ref: r, Name: given } as (11, r, dflt)', async () => {
      const err = await rejection(RDec.insert({ Id: 3, Ref: 'r', Name: 'given' }));

      expect(await rowsOf('s.r_dec')).to.deep.equal([{ Id: 10, Name: 'seed' }]);
      expect(err).to.be.instanceOf(OrmException);
      expect((err as Error).message).to.equal(REFUSAL);
    });

    for (const [name, write] of Object.entries(DESCRIPTOR_WRITES)) {
      it(`refuses ${name} before any statement and leaves the table as it was`, async () => {
        let err: unknown;
        const statements = await statementsDuring(async () => {
          err = await rejection(write());
        });

        expect((err as Error)?.message).to.equal(REFUSAL);
        expect(statements.filter((s) => !s.startsWith('SELECT'))).to.deep.equal([]);
        expect(await rowsOf('s.r_dec')).to.deep.equal([{ Id: 10, Name: 'seed' }]);
      });
    }

    it('refuses archive() of a fetched model instead of resolving with ArchivedAt unset', async () => {
      await run('CREATE TABLE s.r_arch (Id INTEGER PRIMARY KEY, Ref TEXT, ArchivedAt TEXT, Name TEXT)');
      await run("INSERT INTO s.r_arch (Id, Ref, Name) VALUES (1, 'r', 'seed')");
      const m = await RArch.where('Id', 1).first();

      const err = await rejection(m.archive());

      expect((err as Error)?.message).to.match(/^model RArch: table r_arch on connection sqlite was missing when the Orm read it/);
      expect(await sqlite().executeOnDb('SELECT ArchivedAt FROM s.r_arch', [], QueryContext.Select)).to.deep.equal([{ ArchivedAt: null }]);
    });

    it('still runs a static update and a destroy: their statements name their own columns', async () => {
      const statements = await statementsDuring(async () => {
        await RDec.update({ Name: 'changed' }).where('Id', 10);
        expect(await rowsOf('s.r_dec')).to.deep.equal([{ Id: 10, Name: 'changed' }]);
        await RDec.destroy(10);
      });

      expect(statements).to.deep.equal(['UPDATE `s`.`r_dec` SET `Name` = ? WHERE `Id` = ?', 'SELECT Id, Name FROM s.r_dec ORDER BY Id', 'DELETE FROM `s`.`r_dec` WHERE `Id` IN (?)']);
      expect(await rowsOf('s.r_dec')).to.deep.equal([]);
    });

    it('writes every column on every path once reloadTableInfo() read the table', async () => {
      await db().reloadTableInfo();

      await RDec.insert({ Id: 3, Ref: 'r', Name: 'given' });
      await new RDec({ Id: 4, Ref: 'r', Name: 'instance' }).insert();
      await RDec.insert([
        { Id: 5, Ref: 'r', Name: 'bulk5' },
        { Id: 6, Ref: 'r', Name: 'bulk6' },
      ]);
      await new RDec({ Id: 7, Ref: 'r', Name: 'saved' }).save();
      await new RDec({ Id: 10, Ref: 'r', Name: 'upserted' }).insertOrUpdate();
      const fetched = await RDec.where('Id', 3).first();
      fetched.Name = 'fetched';
      await fetched.update();
      await new RDec({ Id: 4, Ref: 'r', Name: 'instance' }).update({ Name: 'patched' });

      expect(await rowsOf('s.r_dec')).to.deep.equal([
        { Id: 3, Name: 'fetched' },
        { Id: 4, Name: 'patched' },
        { Id: 5, Name: 'bulk5' },
        { Id: 6, Name: 'bulk6' },
        { Id: 7, Name: 'saved' },
        { Id: 10, Name: 'upserted' },
      ]);
      expect(extractModelDescriptor(RDec)!.TableMissing).to.equal(false);
    });
  });

  describe('the table does not exist', () => {
    afterEach(() => shutdown());

    for (const attach of [false, true]) {
      it(`refuses with the same error, before any statement, ${attach ? 'with s attached' : 'with s not attached'}`, async () => {
        await boot({ attach, create: false });
        let err: unknown;
        const statements = await statementsDuring(async () => {
          err = await rejection(RDec.insert({ Id: 3, Ref: 'r', Name: 'given' }));
        });

        expect((err as Error)?.message).to.equal(REFUSAL);
        expect(statements).to.deep.equal([]);
      });
    }
  });

  describe('the table existed when the Orm read it', () => {
    let dir: string;

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), 'spinajs-missing-table-present-'));
      dbFile = join(dir, 'present.sqlite');
      DI.register(FileConf).as(Configuration);
      await DI.resolve(Orm);
      await run(`CREATE TABLE r_dec ${TABLE}`);
      await run("INSERT INTO r_dec (Id, Ref, Name) VALUES (10, 'seed', 'seed')");
      await db().dispose();
      DI.clearCache();
      await DI.resolve(Orm);
    });

    afterEach(async () => {
      await db().dispose();
      DI.unregister(Configuration, FileConf);
      DI.clearCache();
      rmSync(dir, { recursive: true, force: true });
    });

    it('writes as before: the same statements and rows', async () => {
      const statements = await statementsDuring(async () => {
        await RDec.insert({ Id: 3, Ref: 'r', Name: 'given' });
        await new RDec({ Id: 4, Ref: 'r', Name: 'instance' }).insert();
        const fetched = await RDec.where('Id', 3).first();
        fetched.Name = 'fetched';
        await fetched.update();
        await new RDec({ Id: 4, Ref: 'r', Name: 'instance' }).update({ Name: 'patched' });
        await RDec.update({ Name: 'changed' }).where('Id', 10);
        await RDec.destroy(4);
      });

      expect(statements).to.deep.equal([
        'INSERT INTO `r_dec` (`Ref`,`Id`,`Name`) VALUES (?,?,?)  RETURNING `Id`',
        'INSERT INTO `r_dec` (`Ref`,`Id`,`Name`) VALUES (?,?,?)  RETURNING `Id`',
        'SELECT * FROM `r_dec` WHERE `Id` = ? LIMIT ?',
        'UPDATE `r_dec` SET `Name` = ? WHERE `Id` = ?',
        'UPDATE `r_dec` SET `Ref` = ?,`Name` = ? WHERE `Id` = ?',
        'UPDATE `r_dec` SET `Name` = ? WHERE `Id` = ?',
        'DELETE FROM `r_dec` WHERE `Id` IN (?)',
      ]);
      expect(await rowsOf('r_dec')).to.deep.equal([
        { Id: 3, Name: 'fetched' },
        { Id: 10, Name: 'changed' },
      ]);
      expect(extractModelDescriptor(RDec)!.TableMissing).to.equal(false);
    });
  });
});

const MIGRATING = 'sqlite-missing-table-up';
const REF = '6f1c1b1e-5d2a-4c3b-9a8e-1f2d3c4b5a69';
let writeIn: 'up' | 'data' = 'up';

class MigratingConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    _.mergeWith(
      this.Config,
      {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
        db: { Connections: [{ Driver: 'orm-driver-sqlite', Filename: dbFile, Name: MIGRATING, Migration: { Table: 'orm_migrations_missing_up' } }] },
      },
      mergeArrays,
    );
  }
}

function defineMigrated() {
  @Connection(MIGRATING)
  @Model('up_item')
  class UpItem extends ModelBase<UpItem> {
    @Primary()
    public Id: number;

    @Uuid()
    public Ref: string;

    public Name: string;
  }

  @Migration(MIGRATING)
  class MissingTableUp_2026_11_28_00_00_00 extends OrmMigration {
    public async up(connection: OrmDriver): Promise<void> {
      await connection.schema().createTable('up_item', (table) => {
        table.int('Id').primaryKey();
        table.binary('Ref', 16);
        table.string('Name').notNull().default().value('dflt');
      });
      if (writeIn === 'up') await UpItem.insert({ Id: 7, Ref: REF, Name: 'seeded' });
    }

    public async down(connection: OrmDriver): Promise<void> {
      await connection.schema().dropTable('up_item');
    }

    public async data(): Promise<void> {
      if (writeIn === 'data') await UpItem.insert({ Id: 7, Ref: REF, Name: 'seeded' });
    }
  }

  return { UpItem, migration: MissingTableUp_2026_11_28_00_00_00 };
}

describe('sqlite: a model write inside a migration', function () {
  this.timeout(60000);

  let defined: ReturnType<typeof defineMigrated>;
  let dir: string;

  before(() => {
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    defined = defineMigrated();
  });

  after(() => {
    DI.unregister(defined.migration);
    DI.unregister(defined.UpItem);
    DI.clearCache();
  });

  beforeEach(() => {
    DI.clearCache();
    dir = mkdtempSync(join(tmpdir(), 'spinajs-missing-table-up-'));
    dbFile = join(dir, 'up.sqlite');
    DI.register(MigratingConf).as(Configuration);
  });

  afterEach(async () => {
    await DI.get(Orm)?.dispose();
    DI.unregister(Configuration, MigratingConf);
    DI.clearCache();
    rmSync(dir, { recursive: true, force: true });
  });

  const rows = async (orm: Orm) => {
    const driver = orm.Connections.get(MIGRATING);
    return driver instanceof SqliteOrmDriver ? ((await driver.executeOnDb('SELECT Id, Name FROM up_item ORDER BY Id', [], QueryContext.Select)) as unknown[]) : undefined;
  };

  it('fails the migration when up() writes through a model into the table it just created', async () => {
    writeIn = 'up';
    const migrator = await resolveMigrationTool();

    const err = await rejection(migrator.migrate());

    expect((err as Error)?.message).to.contain('model UpItem: table up_item on connection sqlite-missing-table-up was missing when the Orm read it');
    expect(await rows(migrator.Orm)).to.deep.equal([]);
  });

  it('writes the given row when data() does it, after the touched models were read again', async () => {
    writeIn = 'data';
    const migrator = await resolveMigrationTool();

    await migrator.migrate();

    expect(await rows(migrator.Orm)).to.deep.equal([{ Id: 7, Name: 'seeded' }]);
  });
});
