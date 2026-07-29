import { CliCommand, Command, Option } from '@spinajs/cli';
import { Log, Logger } from '@spinajs/log-common';
import { Orm } from '@spinajs/orm';
import { resolveCliOrm } from '../orm.js';

export interface IMigrateUpCommandOptions {
  name?: string;
  fake?: boolean;
}

/**
 * `orm.Migration` only exists on a RESOLVED Orm - it is assigned inside `Orm.resolve()`, once the
 * connections it dispatches to have been created. So every command here resolves the Orm first
 * and reaches the facade through it, rather than injecting a migration service directly.
 *
 * Through `resolveCliOrm()`, so that resolve does not run a migration pass of its own: the run
 * below is the one the operator asked for, and it is the only one. Without that, `--fake` on a
 * `Migration.OnStartup` connection would really apply the migrations it promises to merely
 * record, because the boot pass would have executed them before this line is reached.
 */
@Command('migrate-up', 'Runs pending ORM migrations on every configured connection')
@Option('-n, --name [name]', false, 'run a single migration, by class name')
@Option('-f, --fake', false, 'record the migrations as applied without executing them')
export class MigrateUpCommand extends CliCommand {
  @Logger('ORM-CLI')
  protected Log: Log;

  public async execute(options: IMigrateUpCommandOptions): Promise<void> {
    const orm = await resolveCliOrm();
    const executed = await orm.Migration.up(options.name, { fake: options.fake });

    if (executed.length > 0) {
      this.Log.success(`${options.fake ? 'Recorded as applied ( --fake, nothing was executed )' : 'Applied'} ${executed.length} migration(s): ${executed.map((m) => m.constructor.name).join(', ')}`);
      return;
    }

    if (!options.name) {
      this.Log.info('No pending migrations - every configured connection is already up to date');
      return;
    }

    // A named run that applied nothing is ambiguous at this level, and the two readings could not
    // be further apart: the migration is already applied ( fine ), or it never ran because the
    // connection it declares is missing from this deployment and the runner only WARNED about it.
    // `up()` throws outright on a name nothing is registered under, so a typo is already excluded
    // here. `status()` reports exactly the connections that ARE configured, which makes "absent
    // from status" the reliable signal for the second case.
    await this.explainEmptyNamedRun(orm, options.name);
  }

  /**
   * Turns an empty `up(name)` into a statement about what actually happened - and a non-zero exit
   * code whenever the requested schema change is not in the database, so a deploy script cannot
   * march past it believing "0 applied" meant "nothing left to do".
   */
  protected async explainEmptyNamedRun(orm: Orm, name: string): Promise<void> {
    const entry = (await orm.Migration.status()).find((e) => e.name === name);

    if (!entry) {
      this.Log.error(`Migration ${name} did NOT run: it is registered, but the connection it declares is not configured here ( or the class carries no @Migration('connection') decorator ). Nothing was applied.`);
      process.exitCode = 1;
      return;
    }

    if (entry.applied) {
      this.Log.info(`Migration ${name} is already applied on connection ${entry.connection} ( batch ${entry.batch ?? '-'} ) - nothing to do`);
      return;
    }

    if (entry.failed) {
      this.Log.error(`Migration ${name} did NOT run - it is in the FAILED state on connection ${entry.connection}. It blocks every later migrate-up on that connection until migrate-resolve records what really happened.`);
    } else {
      this.Log.error(`Migration ${name} did NOT run and is still pending on connection ${entry.connection} - check migrate-status`);
    }

    process.exitCode = 1;
  }
}
