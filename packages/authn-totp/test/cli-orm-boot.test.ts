import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A process like `spinajs authn:mfa-reset`: the cli resolves only the command it runs and boots nothing else. Its own
 * process, because the other suites already brought an Orm up in this one. With CLI_MIGRATE set, a migrate-up run in a
 * container of its own goes first, on the same database file.
 */
const CLI_PROCESS = `
  const { DI } = await import('@spinajs/di');
  const { Configuration, FrameworkConfiguration } = await import('@spinajs/configuration');
  const { Orm, MigrationTransactionMode, PendingMigrationsException } = await import('@spinajs/orm');
  const { migrateTestDatabase } = await import('@spinajs/orm/testing');
  const { SqliteOrmDriver } = await import('@spinajs/orm-sqlite');
  const { IdentityStore } = await import('@spinajs/authn/contracts');
  const { FakeIdentityStore } = await import('@spinajs/authn-testing');
  // DbMfaSecretStore, and authn-orm with its DB defaults.
  await import('./lib/mjs/db.js');
  DI.setESMModuleSupport();
  class CliProcessConfiguration extends FrameworkConfiguration {
    constructor() { super(); this.Env = 'development'; }
    loadSources() { this.Sources = []; }
    onLoad() {
      return {
        logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
        db: {
          DefaultConnection: 'sqlite',
          Connections: [{ Driver: 'orm-driver-sqlite', Filename: process.env.CLI_DB, Name: 'sqlite', Migration: { Table: 'orm_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } } }],
        },
      };
    }
  }
  DI.register(CliProcessConfiguration).as(Configuration);
  DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  // A memory IdentityStore: only the MFA side of the graph needs the database.
  DI.register(FakeIdentityStore).as(IdentityStore);
  await DI.resolve(Configuration);
  await import('./lib/mjs/index.js');
  if (process.env.CLI_MIGRATE) {
    const { orm: tool } = await migrateTestDatabase(DI.child());
    await tool.dispose();
  }
  let result;
  try {
    await DI.resolve((await import('./lib/mjs/cli/MfaReset.js')).MfaReset);
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

function cliProcess(db: string, migrate: boolean): ICliResult {
  const env: NodeJS.ProcessEnv = { ...process.env, CLI_DB: db };
  delete env.NODE_OPTIONS;
  delete env.CLI_MIGRATE;
  if (migrate) {
    env.CLI_MIGRATE = '1';
  }

  const r = spawnSync(process.execPath, ['--input-type=module', '-e', CLI_PROCESS], { cwd: PKG_ROOT, encoding: 'utf8', env });
  expect(r.status, r.stderr).to.eq(0);
  const out = r.stdout.trim().split(/\r?\n/);
  return JSON.parse(out[out.length - 1]) as ICliResult;
}

describe('authn:mfa-reset boots the Orm through the services it injects', function () {
  this.timeout(120000);

  let dir = '';

  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'spinajs-authn-totp-cli-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolving MfaReset refuses an unmigrated database and names migrate-up', () => {
    const result = cliProcess(join(dir, 'cli.sqlite'), false);

    expect(result.pending, result.message).to.eq(true);
    expect(result.message).to.contain('npx spinajs migrate-up');
    expect(result.orm).to.eq(false);
  });

  it('resolving MfaReset after migrate-up brings the Orm up', () => {
    const result = cliProcess(join(dir, 'cli.sqlite'), true);

    expect(result.message).to.eq(undefined);
    expect(result.orm).to.eq(true);
  });
});
