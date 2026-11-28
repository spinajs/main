import { expect } from 'chai';
import 'mocha';
import * as sinon from 'sinon';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DI, NewInstance } from '@spinajs/di';
import { CONFIGURATION_PROPERTY } from '@spinajs/configuration-common';
import { InternalLogger } from '@spinajs/internal-logger';
import { Orm, OrmDriver, OrmMigrationGuard, OrmMigrator, QueryContext } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { testHost } from '@spinajs/authz-testing';
import '@spinajs/log';

import { DbConfigSourceBotstrapper } from '../src/index.js';

const SLUG = 'tableCheck.exposed';
const DRIVER = 'orm-driver-sqlite-attach-s';

/** Where the connecting driver puts the `configuration` table; set by each test before the Orm resolves. */
const layout = { file: '', tableIn: 's' as 'main' | 's' };

/** An application driver that attaches a database while it connects, the only way a table in it exists when the Orm resolves. */
@NewInstance()
class AttachingDriver extends SqliteOrmDriver {
  public async connect(): Promise<OrmDriver> {
    await super.connect();
    await this.executeOnDb('ATTACH DATABASE ? AS s', [layout.file], QueryContext.Schema);
    await this.executeOnDb(
      `CREATE TABLE ${layout.tableIn}.configuration (Id INTEGER PRIMARY KEY AUTOINCREMENT, Slug TEXT NOT NULL UNIQUE, Value TEXT, "Default" TEXT, Required INTEGER DEFAULT 0, Exposed INTEGER NOT NULL DEFAULT 0, Watch INTEGER NOT NULL DEFAULT 0, "Group" TEXT, Label TEXT, Description TEXT, Environment TEXT, Meta TEXT, Type TEXT NOT NULL)`,
      [],
      QueryContext.Schema,
    );
    return this;
  }
}

interface Internals {
  tableExists(orm: Orm): Promise<boolean>;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('configuration table check on a connection with a Database', function () {
  this.timeout(30000);

  let sandbox: string;
  let files = 0;
  let orm: Orm | undefined;
  let bootstrapper: DbConfigSourceBotstrapper;
  let error: sinon.SinonStub;
  let check: sinon.SinonSpy<[Orm], Promise<boolean>>;

  before(async () => {
    sandbox = mkdtempSync(join(tmpdir(), 'spinajs-config-db-table-check-'));
    await testHost.installHost();
    DI.register(AttachingDriver).as(DRIVER);
    testHost.config().set(['logger'], { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] });
    DI.register({ path: SLUG, options: { expose: true, exposeOptions: { type: 'string', group: 'table-check' } } }).asValue(CONFIGURATION_PROPERTY.key);
  });

  after(async () => {
    DI.unregister(AttachingDriver);
    testHost.config().reset();
    await testHost.uninstallHost();
    rmSync(sandbox, { recursive: true, force: true });
  });

  beforeEach(() => {
    files += 1;
    layout.file = join(sandbox, `s-${files}.sqlite`);
    error = sinon.stub(InternalLogger, 'error');
  });

  afterEach(async () => {
    error.restore();
    bootstrapper.unbind();
    await orm?.dispose();
    orm = undefined;
    DI.uncache(OrmMigrator);
    DI.uncache(OrmMigrationGuard);
    DI.uncache(Orm);
    DI.uncache(DbConfigSourceBotstrapper);
  });

  /** Boots the Orm over a connection whose `configuration` table is in `tableIn`, and waits for the bootstrapper's check and sweep. */
  async function boot(tableIn: 'main' | 's', connection: Record<string, unknown>, db: Record<string, unknown> = {}): Promise<boolean> {
    layout.tableIn = tableIn;
    testHost.config().set(['db'], { DefaultConnection: 'sqlite', ...db, Connections: [{ Driver: DRIVER, Filename: ':memory:', Name: 'sqlite', Migration: { Check: 'off' }, ...connection }] });

    // resolved, not constructed: the sweep needs the injected converter
    bootstrapper = await DI.resolve(DbConfigSourceBotstrapper);
    check = sinon.spy(bootstrapper as unknown as Internals, 'tableExists');
    await bootstrapper.bootstrap();
    orm = await DI.resolve(Orm);

    expect(check.callCount, 'the Orm signal ran the table check').to.equal(1);
    const ready = await check.firstCall.returnValue;
    // the sweep the check starts is not awaited by the bootstrapper
    await wait(300);
    return ready;
  }

  async function slugsIn(schema: 'main' | 's'): Promise<string[]> {
    const driver = orm?.Connections.get('sqlite');
    if (!(driver instanceof SqliteOrmDriver)) throw new Error('the test connection is not booted');
    const rows = (await driver.executeOnDb(`SELECT Slug FROM ${schema}.configuration`, [], QueryContext.Select)) as Array<{ Slug: string }>;
    return rows.map((r) => r.Slug);
  }

  const persistFailures = () => error.getCalls().filter((c) => c.args[1] === 'Failed to persist exposed config options to db');

  it('sweeps the exposed options into the table of the attached database the connection names', async () => {
    expect(await boot('s', { Database: 's' })).to.equal(true);

    expect(await slugsIn('s')).to.deep.equal([SLUG]);
    expect(persistFailures()).to.have.length(0);
  });

  it('sweeps into main on a connection without a Database, as before', async () => {
    expect(await boot('main', {})).to.equal(true);

    expect(await slugsIn('main')).to.deep.equal([SLUG]);
    expect(persistFailures()).to.have.length(0);
  });

  it('does not sweep when only main holds the table the connection does not read', async () => {
    // with db.StrictTableCheck on, the Orm itself refuses to boot without the model's table
    expect(await boot('main', { Database: 's' }, { StrictTableCheck: false })).to.equal(false);

    expect(await slugsIn('main')).to.deep.equal([]);
    expect(persistFailures(), 'no insert was tried').to.have.length(0);
  });
});
