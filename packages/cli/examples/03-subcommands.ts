/**
 * Nested subcommands via `parent`, plus an alias.
 *
 * Run:
 *   spinajs db migrate
 *   spinajs db seed          # or: spinajs db fixtures
 */
import { Log, Logger } from '@spinajs/log';
import { CliCommand, Command } from '@spinajs/cli';

@Command({ nameAndArgs: 'db', description: 'Database commands' })
export class DbCommand extends CliCommand {
  // a parent command may have its own action, or simply group children
  public async execute(): Promise<void> {
    return Promise.resolve();
  }
}

@Command({ nameAndArgs: 'migrate', description: 'Run pending migrations', parent: 'db' })
export class DbMigrateCommand extends CliCommand {
  @Logger('db')
  protected Log: Log;

  public async execute(): Promise<void> {
    this.Log.info('running migrations...');
  }
}

@Command({ nameAndArgs: 'seed', description: 'Seed the database', parent: 'db', aliases: ['fixtures'] })
export class DbSeedCommand extends CliCommand {
  @Logger('db')
  protected Log: Log;

  public async execute(): Promise<void> {
    this.Log.info('seeding database...');
  }
}
