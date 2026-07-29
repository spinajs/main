import { CliCommand, Command, Option } from '@spinajs/cli';
import { Log, Logger } from '@spinajs/log-common';
import { resolveCliOrm } from '../orm.js';

export interface IMigrateDownCommandOptions {
  name?: string;
  all?: boolean;
  fake?: boolean;
}

/**
 * The description says LAST BATCH out loud, and so does the pre-run line below: `down()` defaults
 * to the last applied batch, not to everything, and an operator who assumed otherwise would read
 * a short "rolled back 1 migration" as a complete teardown.
 */
@Command('migrate-down', 'Rolls ORM migrations back - the LAST APPLIED BATCH only, unless --all is given')
@Option('-n, --name [name]', false, 'roll back a single migration, by class name')
@Option('-a, --all', false, 'roll back EVERY applied migration, not just the last batch')
@Option('-f, --fake', false, 'record the migrations as rolled back without executing them')
export class MigrateDownCommand extends CliCommand {
  @Logger('ORM-CLI')
  protected Log: Log;

  public async execute(options: IMigrateDownCommandOptions): Promise<void> {
    // Not `DI.resolve(Orm)`: a boot migration pass would apply the pending migrations on every
    // `Migration.OnStartup` connection and this command would then roll back the batch it had
    // just created. See `resolveCliOrm`.
    const orm = await resolveCliOrm();

    this.announce(options);

    const executed = await orm.Migration.down(options.name, { all: options.all, fake: options.fake });

    if (executed.length === 0) {
      this.Log.info(options.name ? `Nothing rolled back - ${options.name} is not applied on any configured connection` : 'Nothing to roll back - no applied migrations found');
      return;
    }

    this.Log.success(`${options.fake ? 'Recorded as rolled back ( --fake, nothing was executed )' : 'Rolled back'} ${executed.length} migration(s): ${executed.map((m) => m.constructor.name).join(', ')}`);
  }

  /**
   * Says what scope is about to be reversed BEFORE it is reversed, because by the time the result
   * line is printed the schema change has already happened.
   */
  protected announce(options: IMigrateDownCommandOptions): void {
    if (options.name) {
      // A named rollback hands the migration service a one-element unit list, so every other
      // applied row in the target batch looks unmatched to it and it warns about them. Those rows
      // are healthy - only the warning is wrong - and the remedy it suggests is destructive if
      // followed here, which is why this line says what to do with those warnings instead of
      // leaving the operator to act on them.
      this.Log.warn(`Rolling back a single migration: ${options.name}. The migration service may warn during this run that other migrations have no matching registered class - that is an artifact of a named rollback, those rows are fine. Do not edit or delete them.`);
      return;
    }

    if (options.all) {
      this.Log.warn('Rolling back EVERY applied migration on every configured connection ( --all )');
      return;
    }

    this.Log.info('Rolling back the LAST APPLIED BATCH only - pass --all to reverse every applied migration');
  }
}
