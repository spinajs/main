/**
 * Runs `@spinajs/cli` in a fresh process the way its bin does: the scheduler is reached only through
 * the command files in `system.dirs.cli`, never through the package index.
 * Usage: node --loader ts-node/esm cli-child.ts <command> [args...]
 */
import { readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { MigrationTransactionMode } from '@spinajs/orm';
import { migrateTestDatabase } from '@spinajs/orm/testing';
import '@spinajs/orm-sqlite';
import '@spinajs/log';

const dir = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
// CLI_CHILD_DB_DIR: one database file per connection there, migrated by a run of its own (CLI_CHILD_MIGRATE=0: not at
// all) before the command, as a deploy step runs migrate-up; the command then starts with no Orm resolved, as the cli does.
const dbDir = process.env.CLI_CHILD_DB_DIR;
const sqlite = (name: string) => ({
  Driver: 'orm-driver-sqlite',
  Filename: dbDir ? join(dbDir, `${name}.sqlite`) : ':memory:',
  Name: name,
  Migration: { Table: 'orm_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } },
});

class CliChildConf extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '{message}' }],
        rules: [{ name: '*', level: 'error', target: 'Empty' }],
      },
      db: { DefaultConnection: 'sqlite', Connections: [sqlite('sqlite'), sqlite('queue')] },
      system: { dirs: { schedules: [dir('../fixtures/cli-schedules')] } },
      scheduler: { retention: { enabled: process.env.CLI_CHILD_RETENTION === '1' } },
    };
  }
}

async function main() {
  DI.setESMModuleSupport();
  DI.register(CliChildConf).as(Configuration);
  DI.register(() => ['node', 'spinajs', ...process.argv.slice(2)]).as('__cli_argv_provider__');
  const config = await DI.resolve(Configuration);
  // shipped package configs add every compiled package's cli dir (this one's lib too); test the sources only
  const cliDir = dir('../../src/cli');
  config.set('system.dirs.cli', [cliDir]);
  const { Cli } = await import('@spinajs/cli');
  // the models and migrations the commands bring in must be registered before the Orm is built
  for (const file of readdirSync(cliDir)) await import(pathToFileURL(join(cliDir, file)).href);
  if (!dbDir) {
    await migrateTestDatabase();
  } else if (process.env.CLI_CHILD_MIGRATE !== '0') {
    const { orm } = await migrateTestDatabase(DI.child());
    await orm.dispose();
  }
  await DI.resolve(Cli);
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err: Error) => {
    console.error(err.stack ?? err.message);
    process.exit(99);
  });
