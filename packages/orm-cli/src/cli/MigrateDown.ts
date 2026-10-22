import { CliCommand, Command, Option } from '@spinajs/cli';
import { Log, Logger } from '@spinajs/log-common';
import { resolveCliMigrator } from '../orm.js';

export interface IMigrateDownCommandOptions {
  name?: string;
  all?: boolean;
  fake?: boolean;
  connection?: string;
}

/**
 * The description says LAST BATCH out loud, and so does the pre-run line below: `down()` defaults
 * to the last applied batch, not to everything, and an operator who assumed otherwise would read
 * a short "rolled back 1 migration" as a complete teardown.
 */
@Command('migrate-down', 'Rolls ORM migrations back - the LAST APPLIED BATCH only, unless --all is given')
@Option('-n, --name [name]', false, 'roll back a single migration, by class name')
@Option('-c, --connection [connection]', false, 'limit the rollback to one connection, by name')
@Option('-a, --all', false, 'roll back EVERY applied migration, not just the last batch')
@Option('-f, --fake', false, 'record the migrations as rolled back without executing them')
export class MigrateDownCommand extends CliCommand {
  @Logger('ORM-CLI')
  protected Log: Log;

  public async execute(options: IMigrateDownCommandOptions): Promise<void> {
    const migrator = await resolveCliMigrator();

    this.announce(options);

    const executed = await migrator.Runner.down(options.name, { all: options.all, fake: options.fake, connection: options.connection });

    if (executed.length === 0) {
      if (options.name) {
        this.Log.info(
          { migration: options.name, connection: options.connection },
          options.connection ? 'Nothing rolled back - ${migration} is not applied on connection ${connection}' : 'Nothing rolled back - ${migration} is not applied on any configured connection',
        );
      } else {
        this.Log.info({ connection: options.connection }, 'Nothing to roll back - no applied migrations found${?connection} on connection ${connection}${/connection}');
      }
      return;
    }

    this.Log.success(
      { count: executed.length, migrations: executed.map((m) => m.constructor.name) },
      options.fake ? 'Recorded as rolled back ( --fake, nothing was executed ) ${count} migration(s): ${migrations}' : 'Rolled back ${count} migration(s): ${migrations}',
    );
  }

  /**
   * Says what scope is about to be reversed BEFORE it is reversed, because by the time the result
   * line is printed the schema change has already happened.
   */
  protected announce(options: IMigrateDownCommandOptions): void {
    // first, and separate from the three below: it narrows all of them, and an operator reading
    // "rolling back EVERY applied migration" needs to know it means every one on ONE connection
    if (options.connection) {
      this.Log.info({ connection: options.connection }, 'Limited to connection ${connection} - no other configured connection is touched');
    }

    if (options.name) {
      // A named rollback hands the migration service a one-element unit list, so every other
      // applied row in the target batch looks unmatched to it and it warns about them. Those rows
      // are healthy - only the warning is wrong - and the remedy it suggests is destructive if
      // followed here, which is why this line says what to do with those warnings instead of
      // leaving the operator to act on them.
      this.Log.warn(
        { migration: options.name },
        'Rolling back a single migration: ${migration}. The migration service may warn during this run that other migrations have no matching registered class - that is an artifact of a named rollback, those rows are fine. Do not edit or delete them.',
      );
      return;
    }

    if (options.all) {
      if (options.connection) {
        this.Log.warn({ connection: options.connection }, 'Rolling back EVERY applied migration on connection ${connection} ( --all )');
      } else {
        this.Log.warn('Rolling back EVERY applied migration on every configured connection ( --all )');
      }
      return;
    }

    this.Log.info('Rolling back the LAST APPLIED BATCH only - pass --all to reverse every applied migration');
  }
}
