import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Migration, Orm, OrmDriver, OrmMigration, OrmMigrator, resolveMigrationTool } from '@spinajs/orm';
import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import _ from 'lodash';
import 'mocha';
import '@spinajs/log';

import { SqliteOrmDriver } from '../src/index.js';
import { mergeArrays } from './util.js';

const CONNECTION = 'sqlite-run-lock';

let dbFile = '';

/** What both runs did, in order; a migration that ran twice shows up twice. */
const events: string[] = [];

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class RunLockConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
        db: {
          StrictTableCheck: false,
          Connections: [{ Driver: 'orm-driver-sqlite', Filename: dbFile, Name: CONNECTION, Migration: { Table: 'run_lock_migrations', Lock: { Timeout: 10_000 } } }],
        },
      },
      mergeArrays,
    );
  }
}

function defineMigration() {
  @Migration(CONNECTION)
  class RunLockSqlite_2026_11_01_00_00_00 extends OrmMigration {
    public async up(connection: OrmDriver): Promise<void> {
      events.push('up');
      await delay(300);
      await connection.schema().createTable('run_lock_marker', (t) => {
        t.int('Id').primaryKey();
      });
    }

    public async down(connection: OrmDriver): Promise<void> {
      await connection.schema().dropTable('run_lock_marker');
    }

    public async data(): Promise<void> {
      events.push('seed:start');
      // longer than the lock poll interval: a lock released before the seeds lets the other run in here
      await delay(1_500);
      events.push('seed:end');
    }
  }

  return RunLockSqlite_2026_11_01_00_00_00;
}

/** A migrate-up process of its own: its own container, configuration, Orm and connection. */
async function tool(): Promise<{ migrator: OrmMigrator; orm: Orm }> {
  const container = DI.child();
  container.register(RunLockConf).as(Configuration);

  const migrator = await resolveMigrationTool(container);
  return { migrator, orm: await container.resolve(Orm) };
}

describe('sqlite migration run lock across two Orm instances', function () {
  this.timeout(30_000);

  let migration: ReturnType<typeof defineMigration>;
  let dir = '';
  const opened: Orm[] = [];

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinajs-lock-'));
    dbFile = path.join(dir, 'run-lock.sqlite');
    migration = defineMigration();
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  after(async () => {
    for (const orm of opened) {
      await orm.dispose();
    }

    DI.unregister(migration);
    DI.clearCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('applies a migration once, and the second run waits for the first one including its seeds', async () => {
    const [a, b] = await Promise.all([tool(), tool()]);
    opened.push(a.orm, b.orm);
    expect(a.orm.Connections.get(CONNECTION)).to.not.equal(b.orm.Connections.get(CONNECTION));

    const run = async (name: string, migrator: OrmMigrator, after: number) => {
      await delay(after);
      events.push(`done:${name}:${(await migrator.migrate()).length}`);
    };

    await Promise.all([run('a', a.migrator, 0), run('b', b.migrator, 50)]);

    expect(events).to.eql(['up', 'seed:start', 'seed:end', 'done:a:1', 'done:b:0']);
  });
});
