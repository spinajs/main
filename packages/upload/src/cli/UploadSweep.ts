import { CliCommand, Command } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { OrmMigrator } from '@spinajs/orm';

import { UploadSweeper } from '../sweeper.js';

/** For setups that schedule with cron. Prints `<count> <name>` per counter; exit code 1 when an item failed. */
@Command('upload:sweep', 'Runs the upload sweeper once: expiry, stale claims, retention, leftover objects, owed final events')
export class UploadSweep extends CliCommand {
  /** The cli resolves only the command, so the command runs the `Migration.OnStartup` pass that opens model queries. */
  @Autoinject(OrmMigrator)
  protected Migrator: OrmMigrator;

  @Autoinject(UploadSweeper)
  protected Sweeper: UploadSweeper;

  public async execute(): Promise<void> {
    const result = await this.Sweeper.sweep();
    for (const [name, count] of Object.entries(result)) console.log(`${count} ${name}`);
    if (result.errors > 0) process.exitCode = 1;
  }
}
