import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, Migration, Model, ModelBase, Orm, OrmDriver, OrmMigration, OrmMigrationGuard, PendingMigrationsException, Primary, resolveMigrationTool } from '@spinajs/orm';
import { expect } from 'chai';
import * as fs from 'fs';
import _ from 'lodash';
import 'mocha';
import * as os from 'os';
import * as path from 'path';
import '@spinajs/log';

import { SqliteOrmDriver } from '../src/index.js';
import { mergeArrays } from './util.js';

const CONNECTION = 'sqlite-desktop';

let dbFile: string;
let seeded: string[] = [];

class DesktopConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
        db: {
          StrictTableCheck: true,
          DefaultConnection: CONNECTION,
          Connections: [{ Driver: 'orm-driver-sqlite', Filename: dbFile, Name: CONNECTION }],
        },
      },
      mergeArrays,
    );
  }
}

function defineSchema() {
  @Connection(CONNECTION)
  @Model('desktop_notes')
  class DesktopNote extends ModelBase {
    @Primary()
    public Id: number;

    public Text: string;
  }

  @Migration(CONNECTION)
  class DesktopCreateNotes_2026_11_03_00_00_00 extends OrmMigration {
    public async up(connection: OrmDriver): Promise<void> {
      await connection.schema().createTable('desktop_notes', (table) => {
        table.int('Id').primaryKey().autoIncrement();
        table.string('Text');
      });
    }

    public async down(): Promise<void> {}

    public async data(): Promise<void> {
      seeded.push(this.constructor.name);
    }
  }

  return { DesktopNote, DesktopCreateNotes_2026_11_03_00_00_00 };
}

describe('a desktop app migrating its sqlite file in its own process', function () {
  this.timeout(20000);

  let scratch: string;
  let types: ReturnType<typeof defineSchema>;

  before(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spinajs-desktop-'));
    dbFile = path.join(scratch, 'app.sqlite');
    seeded = [];

    DI.clearCache();
    types = defineSchema();
    DI.register(DesktopConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  after(async () => {
    await DI.get(Orm)?.dispose();
    DI.unregister(types.DesktopNote);
    DI.unregister(types.DesktopCreateNotes_2026_11_03_00_00_00);
    DI.unregister(DesktopConf);
    DI.clearCache();

    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {
      // windows may still hold the file; nothing depends on the cleanup
    }
  });

  it('the boot fails on the pending migration, resolveMigrationTool() then migrates, and the next boot passes', async () => {
    const boot = await Promise.resolve(DI.resolve(Orm)).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(boot).to.be.instanceOf(PendingMigrationsException);

    const migrator = await resolveMigrationTool();
    const executed = await migrator.migrate();
    expect(executed.map((m) => m.constructor.name)).to.deep.equal([types.DesktopCreateNotes_2026_11_03_00_00_00.name]);
    expect(seeded).to.deep.equal([types.DesktopCreateNotes_2026_11_03_00_00_00.name]);

    // the tool Orm skipped the strict table check at its boot
    await migrator.Orm.reloadTableInfo({ strict: true });
    expect(DI.get(Orm)).to.equal(migrator.Orm);
    await types.DesktopNote.insert({ Text: 'first' });
    expect((await types.DesktopNote.all()).map((n) => n.Text)).to.deep.equal(['first']);

    // the next start of the app
    await migrator.Orm.dispose();
    DI.clearCache();
    const orm = await DI.resolve(Orm);

    expect(DI.get(OrmMigrationGuard)?.Enabled).to.be.true;
    expect(orm).to.not.equal(migrator.Orm);
    expect(seeded, 'the boot seeds nothing').to.have.length(1);
    expect((await types.DesktopNote.all()).map((n) => n.Text)).to.deep.equal(['first']);
  });
});
