import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import type { Class } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import '@spinajs/log';
import { Orm, OrmMigrator, type IDriverOptions } from '@spinajs/orm';
import { PgliteOrmDriver, execOnSharedPglite } from '@spinajs/orm-pglite';
import { createTestApp } from '@spinajs/testing';

import { resetFactorySequences } from './factory.js';

export type TestDatabaseStrategy = 'schema' | 'template';

/** The process-wide PGlite instance the `schema` strategy puts its schemas in. */
export const TEST_PGLITE_INSTANCE = 'spinajs-testing-orm';

export interface TestDatabaseOptions {
  /** Default `pglite`. */
  dialect?: 'pglite' | 'sqlite';
  /** The connection name; `@Migration(name)` migrations apply ( and `@Migration('default')` ones when it is the default connection ). Default `default`. */
  connection?: string;
  /** Run the registered migrations. Default true. */
  migrate?: boolean;
  /**
   * PGlite only. `schema` ( default ): a new schema on one PGlite instance shared by the process; the app's boot runs
   * the migrations in it. `template`: the migrations run once per process into a dumped instance, and every boot loads
   * its own copy of the dump.
   */
  strategy?: TestDatabaseStrategy;
  /**
   * `template` only: the configuration the template boot runs with, for migrations whose `data()` reads app config.
   * Its connection of the same name is replaced by the test database. Default: `FrameworkConfiguration`.
   */
  configuration?: Class<Configuration>;
}

export interface TestDatabase {
  /** The `db.Connections` entry. JSON-safe, so `createTestApp({ config })` can carry it. */
  config: Partial<IDriverOptions>;
  /** `schema`: drops the schema; call it after the app that used it is disposed. Otherwise nothing is left to clean. */
  dispose(): Promise<void>;
}

const SILENT_LOGGER = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] };
const PGLITE = 'orm-driver-pglite';

const templates = new Map<string, Promise<string>>();
const configurationIds = new WeakMap<object, number>();
let configurations = 0;
let templateFiles = 0;
let templateDir: string | undefined;

/** A database for one test app. Call it before creating the app that uses it. */
export async function createTestDatabase(options: TestDatabaseOptions = {}): Promise<TestDatabase> {
  resetFactorySequences();
  const connection = options.connection ?? 'default';
  const migrate = options.migrate ?? true;
  const Migration = { OnStartup: migrate };

  if (options.dialect === 'sqlite') {
    return { config: { Driver: 'orm-driver-sqlite', Name: connection, Filename: ':memory:', Migration }, dispose: () => Promise.resolve() };
  }

  const strategy = options.strategy ?? 'schema';
  if (strategy === 'template' && !migrate) {
    throw new InvalidArgument(`createTestDatabase: a template is a migrated database; use migrate: false with strategy 'schema'`);
  }

  if (strategy === 'schema') {
    const schema = `tdb_${process.pid}_${randomBytes(4).toString('hex')}`;
    return {
      config: { Driver: PGLITE, Name: connection, Migration, Options: { Shared: TEST_PGLITE_INSTANCE, Schema: schema } },
      dispose: async () => {
        await execOnSharedPglite(TEST_PGLITE_INSTANCE, `DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      },
    };
  }

  const template = await templateFor(connection, options.configuration ?? FrameworkConfiguration);
  // Migrations registered after the template was taken still run on the app's boot.
  return { config: { Driver: PGLITE, Name: connection, Migration, Options: { LoadDataDir: template } }, dispose: () => Promise.resolve() };
}

function templateFor(connection: string, configuration: Class<Configuration>): Promise<string> {
  const key = `${connection}#${configurationId(configuration)}`;
  let template = templates.get(key);

  if (!template) {
    template = buildTemplate(connection, configuration);
    templates.set(key, template);
    // A failed build is not kept: the next call retries it and reports its own error.
    template.catch(() => templates.delete(key));
  }

  return template;
}

function configurationId(configuration: Class<Configuration>): number {
  let id = configurationIds.get(configuration);
  if (id === undefined) {
    id = ++configurations;
    configurationIds.set(configuration, id);
  }

  return id;
}

async function buildTemplate(connection: string, configuration: Class<Configuration>): Promise<string> {
  // A root test app of its own: the first template call must come before the test's app exists.
  const app = await createTestApp({
    name: `testing-orm template ${connection}`,
    configuration: withConnection(configuration, { Driver: PGLITE, Name: connection, Migration: { OnStartup: true } }),
    register: (container) => container.register(PgliteOrmDriver).as(PGLITE),
    resolve: [OrmMigrator],
  });

  try {
    const driver = (await app.resolve(Orm)).Connections.get(connection) as PgliteOrmDriver;
    const file = join(templateDirectory(), `template-${++templateFiles}.tar`);
    writeFileSync(file, new Uint8Array(await (await driver.dumpDataDir()).arrayBuffer()));
    return file;
  } finally {
    await app.dispose();
  }
}

function templateDirectory(): string {
  if (!templateDir) {
    const dir = mkdtempSync(join(tmpdir(), 'spinajs-testing-orm-'));
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
    templateDir = dir;
  }

  return templateDir;
}

/** `base` with `connection` in place of its connection of the same name, no table check and a silent logger. */
function withConnection(base: Class<Configuration>, connection: Partial<IDriverOptions>): Class<Configuration> {
  return class TemplateConfiguration extends (base as typeof FrameworkConfiguration) {
    public async resolve(): Promise<void> {
      await super.resolve();

      const others = this.get<Array<Partial<IDriverOptions>>>('db.Connections', []).filter((c) => c.Name !== connection.Name);
      this.set('db.Connections', [...others, connection]);
      // The template holds this connection's tables only; models of other connections have none here.
      this.set('db.StrictTableCheck', false);
      if (!this.get<string | undefined>('db.DefaultConnection', undefined)) {
        this.set('db.DefaultConnection', connection.Name);
      }
      this.set('logger', SILENT_LOGGER);
    }
  };
}
