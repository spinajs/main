/* eslint-disable no-console */
import { CliCommand, Command, Option } from '@spinajs/cli';
import { compareMigrationNames, IMigrationStatusEntry } from '@spinajs/orm';
import { resolveCliMigrator } from '../orm.js';

/**
 * The report goes to stdout with `console.log`, not through the framework logger: it is this
 * command's OUTPUT - something an operator greps and a script pipes - and routing it through the
 * log would let a configured level or target silently swallow it.
 */
export interface IMigrateStatusCommandOptions {
  connection?: string;
  json?: boolean;
}

@Command('migrate-status', 'Prints what is applied, when, and what is pending, per configured connection')
@Option('-c, --connection [connection]', false, 'report one connection, by name')
@Option('--json', false, 'print one JSON document instead of the table')
export class MigrateStatusCommand extends CliCommand {
  public async execute(options: IMigrateStatusCommandOptions = {}): Promise<void> {
    // a logger target writing to the console would put log lines into the one document a script parses
    const entries = options.json ? await this.withConsoleOnStderr(() => this.collect(options)) : await this.collect(options);
    // the runner returns per-connection groups; the pending list is the order migrate-up applies them in
    const pending = entries.filter((e) => e.pending).sort((a, b) => compareMigrationNames(a.name, b.name));

    if (options.json) {
      console.log(JSON.stringify({ entries: entries.map((e) => this.toJson(e)), pending: pending.map((e) => ({ name: e.name, connection: e.connection })) }, null, 2));
    } else {
      this.printTable(entries, pending);
    }

    if (entries.some((e) => e.failed) || pending.length > 0) {
      process.exitCode = 1;
    }
  }

  protected async collect(options: IMigrateStatusCommandOptions): Promise<IMigrationStatusEntry[]> {
    return (await resolveCliMigrator()).Runner.status({ readOnly: true, connection: options.connection });
  }

  private async withConsoleOnStderr<T>(fn: () => Promise<T>): Promise<T> {
    const { log, info } = console;

    console.log = console.error;
    console.info = console.error;

    try {
      return await fn();
    } finally {
      console.log = log;
      console.info = info;
    }
  }

  protected toJson(e: IMigrationStatusEntry) {
    return { name: e.name, connection: e.connection, state: this.state(e), batch: e.batch, appliedAt: e.applied ? this.iso(e.finishedAt) : null, startedAt: this.iso(e.startedAt), checksumMismatch: e.checksumMismatch };
  }

  protected iso(d: Date | string | null): string | null {
    if (!d) {
      return null;
    }

    // a dialect that hands timestamps back as strings would make toISOString() throw out of a report
    return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : String(d);
  }

  protected printTable(entries: IMigrationStatusEntry[], pendingInRunOrder: IMigrationStatusEntry[]): void {
    if (entries.length === 0) {
      console.log('No migrations are registered for any configured connection.');
      return;
    }

    const width = Math.max(...entries.map((e) => e.connection.length), 'CONNECTION'.length);

    console.log(`   ${'STATE'.padEnd(12)} ${'BATCH'.padStart(5)}  ${'APPLIED AT'.padEnd(24)} ${'CONNECTION'.padEnd(width)} MIGRATION`);

    for (const e of entries) {
      // `!!` in the leftmost column, not just the word FAILED: a failed row is the one line in
      // this report that stops every later migrate-up on its connection, and it has to survive
      // being skimmed in a wall of `applied`. `??` earns the same treatment for the opposite
      // reason - an interrupted row stops nothing at all, and the next migrate-up will re-run it.
      const marker = e.failed ? '!!' : e.interrupted ? '??' : '  ';
      const drift = e.checksumMismatch ? ' [checksum mismatch - the file changed after it was applied]' : '';

      const appliedAt = (e.applied ? this.iso(e.finishedAt) : null) ?? '-';

      console.log(`${marker} ${this.state(e).padEnd(12)} ${String(e.batch ?? '-').padStart(5)}  ${appliedAt.padEnd(24)} ${e.connection.padEnd(width)} ${e.name}${drift}`);
    }

    const failed = entries.filter((e) => e.failed);
    // `pending` is already false on a failed row ( the service derives it as `!applied && !failed` ),
    // so the counts below never double-count the same entry.
    const pending = entries.filter((e) => e.pending);

    // `pending` from the service covers "will run on the next migrate-up", which includes rows
    // that were rolled back and rows a killed run left open. The STATE column tells those apart,
    // so the summary has to as well - otherwise the report says "0 pending" nowhere and "N
    // pending" against a list in which no line reads `pending`. The three are disjoint: the
    // service never reports `interrupted` on a row carrying RolledBackAt.
    const interrupted = pending.filter((e) => e.interrupted);
    const rolledBack = pending.filter((e) => e.rolledBack);
    const neverRun = pending.filter((e) => !e.rolledBack && !e.interrupted);

    console.log('');
    console.log(`${entries.length} migration(s): ${entries.filter((e) => e.applied).length} applied, ${neverRun.length} pending, ${rolledBack.length} rolled back, ${interrupted.length} interrupted, ${failed.length} failed, ${entries.filter((e) => e.checksumMismatch).length} with a checksum mismatch`);

    if (pendingInRunOrder.length > 0) {
      console.log('');
      console.log('Pending, in the order migrate-up applies them:');

      for (const p of pendingInRunOrder) {
        console.log(`  ${p.name} ( ${p.connection} )`);
      }
    }

    if (failed.length > 0) {
      this.explainFailed(failed);
    }

    if (interrupted.length > 0) {
      this.explainInterrupted(interrupted);
    }
  }

  protected state(e: IMigrationStatusEntry): string {
    // interrupted is checked before rolled-back and pending, and after failed: it is a narrowing
    // of `pending`, so reporting the broader word would lose the only thing worth saying about it
    return e.failed ? 'FAILED' : e.applied ? 'applied' : e.interrupted ? 'INTERRUPTED' : e.rolledBack ? 'rolled-back' : 'pending';
  }

  /**
   * The counterpart to `explainFailed`, and the wording has to carry the difference: a failed row
   * blocks and waits for a decision, an interrupted one blocks nothing and the next `migrate-up`
   * re-runs it whether or not anybody looked.
   */
  protected explainInterrupted(interrupted: IMigrationStatusEntry[]): void {
    console.log('');
    console.log('An INTERRUPTED migration was started and never finished - the process running it was killed before it could');
    console.log('record either outcome. Nothing blocks: the next migrate-up RE-RUNS it from the top, and how much of the first');
    console.log('attempt is already in the database was never recorded. Establish that before the next run, then either let it');
    console.log('re-run or record what really happened:');

    for (const i of interrupted) {
      console.log('');
      console.log(`  ${i.name} ( ${i.connection} )${i.startedAt ? `, started ${this.iso(i.startedAt)}` : ''}`);
      console.log(`    migrate-resolve --name ${i.name} --applied       # the change IS in the database, do not run it again`);
      console.log(`    migrate-resolve --name ${i.name} --rolled-back   # the change is NOT, run it again on the next migrate-up`);
    }
  }

  protected explainFailed(failed: IMigrationStatusEntry[]): void {
    console.log('');
    console.log('A FAILED migration blocks every later migrate-up on its connection. Establish whether the change actually');
    console.log('reached the database, then record that outcome so the connection is unblocked:');

    for (const f of failed) {
      console.log('');
      console.log(`  ${f.name} ( ${f.connection} )`);
      console.log(`    migrate-resolve --name ${f.name} --applied       # the change IS in the database`);
      console.log(`    migrate-resolve --name ${f.name} --rolled-back   # the change is NOT in the database`);
    }
  }
}
