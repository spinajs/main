import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A process like `spinajs authn:key-list`: the cli resolves only the command it runs and boots nothing else. Its own
 * process, because the other suites already brought an Orm up in this one. With KEYS_CLI_MIGRATE set, a migrate-up
 * run in a container of its own goes first, on the same database file.
 */
const CLI_PROCESS = `
  const { DI } = await import('@spinajs/di');
  const { Configuration, FrameworkConfiguration } = await import('@spinajs/configuration');
  const { Orm, MigrationTransactionMode, PendingMigrationsException } = await import('@spinajs/orm');
  const { migrateTestDatabase } = await import('@spinajs/orm/testing');
  const { SqliteOrmDriver } = await import('@spinajs/orm-sqlite');
  DI.setESMModuleSupport();
  class CliProcessConfiguration extends FrameworkConfiguration {
    constructor() { super(); this.Env = 'development'; }
    loadSources() { this.Sources = []; }
    onLoad() {
      return {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
        db: {
          // authn_nonce comes with authn-orm's migration, which this process does not load.
          StrictTableCheck: false,
          DefaultConnection: 'sqlite',
          Connections: [{ Driver: 'orm-driver-sqlite', Filename: process.env.KEYS_CLI_DB, Name: 'sqlite', Migration: { Table: 'orm_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } } }],
        },
      };
    }
  }
  DI.register(CliProcessConfiguration).as(Configuration);
  DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  await DI.resolve(Configuration);
  await import('./lib/mjs/index.js');
  if (process.env.KEYS_CLI_MIGRATE) {
    const { orm: tool } = await migrateTestDatabase(DI.child());
    await tool.dispose();
  }
  const name = process.env.KEYS_CLI_COMMAND;
  let result;
  try {
    const command = await DI.resolve((await import('./lib/mjs/cli/' + name + '.js'))[name]);
    if (name === 'ListKeys') {
      await command.execute('service', 'runner-1');
    }
    result = { orm: DI.get(Orm) !== undefined };
  } catch (err) {
    result = { orm: DI.get(Orm) !== undefined, pending: err instanceof PendingMigrationsException, message: err.message };
  }
  await DI.get(Orm)?.dispose();
  console.log(JSON.stringify(result));
  process.exit(0);
`;

interface ICliResult {
  orm: boolean;
  pending?: boolean;
  message?: string;
}

function cliProcess(command: string, db: string, migrate: boolean): ICliResult {
  const env: NodeJS.ProcessEnv = { ...process.env, KEYS_CLI_COMMAND: command, KEYS_CLI_DB: db };
  delete env.NODE_OPTIONS;
  delete env.KEYS_CLI_MIGRATE;
  if (migrate) {
    env.KEYS_CLI_MIGRATE = '1';
  }

  const r = spawnSync(process.execPath, ['--input-type=module', '-e', CLI_PROCESS], { cwd: PKG_ROOT, encoding: 'utf8', env });
  expect(r.status, r.stderr).to.eq(0);
  const out = r.stdout.trim().split(/\r?\n/);
  return JSON.parse(out[out.length - 1]) as ICliResult;
}

describe('key cli commands boot the Orm', function () {
  this.timeout(120000);

  let dir = '';

  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'spinajs-keys-cli-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  for (const command of ['AddKey', 'ListKeys', 'RevokeKey']) {
    it(`resolving ${command} refuses an unmigrated database and names migrate-up`, () => {
      const result = cliProcess(command, join(dir, 'keys.sqlite'), false);

      expect(result.pending, result.message).to.eq(true);
      expect(result.message).to.contain('npx spinajs migrate-up');
      expect(result.orm).to.eq(false);
    });

    it(`resolving ${command} after migrate-up brings the Orm up`, () => {
      const result = cliProcess(command, join(dir, 'keys.sqlite'), true);

      expect(result.message).to.eq(undefined);
      expect(result.orm).to.eq(true);
    });
  }
});
