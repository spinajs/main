import { CliCommand, Command, Option } from '@spinajs/cli';
import { Log, Logger } from '@spinajs/log-common';
import { resolveCliMigrator } from '../orm.js';

export interface IMigrateSeedCommandOptions {
  name?: string;
  connection?: string;
}

/** Runs `OrmMigrator.seed()`: the `data()` hooks of the applied migrations again, in run order, under the run lock. */
@Command('migrate-seed', 'Runs the data() seeds of the applied migrations; seeds must be safe to rerun')
@Option('-n, --name [name]', false, 'seed one applied migration, by class name')
@Option('-c, --connection [connection]', false, 'limit the run to one connection, by name')
export class MigrateSeedCommand extends CliCommand {
  @Logger('ORM-CLI')
  protected Log: Log;

  public async execute(options: IMigrateSeedCommandOptions = {}): Promise<void> {
    const seeded = await (await resolveCliMigrator()).seed({ name: options.name, connection: options.connection });
    this.Log.success({ count: seeded.length, migrations: seeded.map((m) => m.constructor.name) }, 'Seeded ${count} migration(s): ${migrations}');
  }
}
