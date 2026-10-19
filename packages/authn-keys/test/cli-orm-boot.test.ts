import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A process like `spinajs authn:key-list`: the cli resolves only the command it runs and boots nothing else. Its own
 * process, because the other suites already brought an Orm up in this one.
 */
const CLI_PROCESS = `
  const { DI } = await import('@spinajs/di');
  const { Configuration, FrameworkConfiguration } = await import('@spinajs/configuration');
  const { Orm, MigrationTransactionMode } = await import('@spinajs/orm');
  const { SqliteOrmDriver } = await import('@spinajs/orm-sqlite');
  DI.setESMModuleSupport();
  class CliProcessConfiguration extends FrameworkConfiguration {
    constructor() { super(); this.Env = 'development'; }
    loadSources() { this.Sources = []; }
    onLoad() {
      return {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
        db: {
          DefaultConnection: 'sqlite',
          Connections: [{ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite', Migration: { Table: 'orm_migrations', OnStartup: true, Transaction: { Mode: MigrationTransactionMode.PerMigration } } }],
        },
      };
    }
  }
  DI.register(CliProcessConfiguration).as(Configuration);
  DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  await DI.resolve(Configuration);
  await import('./lib/mjs/index.js');
  const name = process.env.KEYS_CLI_COMMAND;
  const command = await DI.resolve((await import('./lib/mjs/cli/' + name + '.js'))[name]);
  const orm = DI.get(Orm) !== undefined;
  if (orm && name === 'ListKeys') {
    await command.execute('service', 'runner-1');
  }
  console.log(JSON.stringify({ orm }));
  process.exit(0);
`;

function cliProcess(command: string): { orm: boolean } {
  const env: NodeJS.ProcessEnv = { ...process.env, KEYS_CLI_COMMAND: command };
  delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', CLI_PROCESS], { cwd: PKG_ROOT, encoding: 'utf8', env });
  expect(r.status, r.stderr).to.eq(0);
  const out = r.stdout.trim().split(/\r?\n/);
  return JSON.parse(out[out.length - 1]) as { orm: boolean };
}

describe('key cli commands boot the Orm', function () {
  this.timeout(120000);

  for (const command of ['AddKey', 'ListKeys', 'RevokeKey']) {
    it(`resolving ${command} brings the Orm up`, () => {
      expect(cliProcess(command).orm).to.eq(true);
    });
  }
});
