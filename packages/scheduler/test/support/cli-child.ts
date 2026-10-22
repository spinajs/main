/**
 * Runs `@spinajs/cli` in a fresh process the way its bin does: the scheduler is reached only through
 * the command files in `system.dirs.cli`, never through the package index.
 * Usage: node --loader ts-node/esm cli-child.ts <command> [args...]
 */
import { fileURLToPath } from 'url';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { MigrationTransactionMode } from '@spinajs/orm';
import '@spinajs/orm-sqlite';
import '@spinajs/log';

const dir = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const sqlite = (name: string) => ({
  Driver: 'orm-driver-sqlite',
  Filename: ':memory:',
  Name: name,
  Migration: { OnStartup: true, Table: 'orm_migrations', Transaction: { Mode: MigrationTransactionMode.PerMigration } },
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
  config.set('system.dirs.cli', [dir('../../src/cli')]);
  const { Cli } = await import('@spinajs/cli');
  await DI.resolve(Cli);
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err: Error) => {
    console.error(err.stack ?? err.message);
    process.exit(99);
  });
