import { CliCommand, Command, Option } from '@spinajs/cli';
import { InvalidArgument } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log-common';
import { MigrationResolveAction } from '@spinajs/orm';
import { resolveCliMigrator } from '../orm.js';

export interface IMigrateResolveCommandOptions {
  name: string;
  applied?: boolean;
  rolledBack?: boolean;
}

@Command('migrate-resolve', 'Records the outcome of a FAILED migration - the escape hatch for a run that died halfway')
@Option('-n, --name [name]', true, 'migration class name')
@Option('--applied', false, 'record it as applied - the change IS in the database')
@Option('--rolled-back', false, 'record it as rolled back - the change is NOT in the database, run it again later')
export class MigrateResolveCommand extends CliCommand {
  @Logger('ORM-CLI')
  protected Log: Log;

  public async execute(options: IMigrateResolveCommandOptions): Promise<void> {
    // validated before any connection is opened: the refusal is about the command line
    const action = this.action(options);

    const migrator = await resolveCliMigrator();

    // The facade accepts only a failed row ( `FinishedAt` NULL and `Logs` set ) or an interrupted
    // one, so a healthy or absent row throws rather than being silently rewritten. That error is
    // let through unchanged; it names the migration and the connection.
    await migrator.Runner.resolve(options.name, action);

    if (action === 'applied') {
      this.Log.success({ migration: options.name }, 'Migration ${migration} is now recorded as applied. It will not run again.');
    } else {
      this.Log.success({ migration: options.name }, 'Migration ${migration} is now recorded as rolled back. It is pending again and WILL run on the next migrate-up.');
    }
  }

  /**
   * Exactly one of the two flags, never both and never neither: the whole point of this command is
   * to state which of the two things actually happened to the database, and neither the CLI nor
   * the service can find that out on its own.
   */
  protected action(options: IMigrateResolveCommandOptions): MigrationResolveAction {
    const applied = options.applied === true;
    const rolledBack = options.rolledBack === true;

    if (applied && rolledBack) {
      throw new InvalidArgument('--applied and --rolled-back are mutually exclusive - a migration either reached the database or it did not');
    }

    if (!applied && !rolledBack) {
      throw new InvalidArgument('one of --applied / --rolled-back is required - resolving a failed migration means recording which of the two actually happened');
    }

    return applied ? 'applied' : 'rolled-back';
  }
}
