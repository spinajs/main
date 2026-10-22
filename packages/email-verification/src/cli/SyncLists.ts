/* eslint-disable no-console */
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { DomainListSync } from '../sync.js';

/** Prints `<source> <status> [count] [error]` per source; exit code 1 when a source failed. */
@Command('email-verification:sync', 'Downloads the configured domain lists into the store')
@Argument('source', false, 'only this list source')
export class SyncLists extends CliCommand {
  @Autoinject(DomainListSync)
  protected Sync: DomainListSync;

  public async execute(source: string | undefined): Promise<void> {
    const outcomes = await this.Sync.run(source);
    for (const o of outcomes) console.log([o.source, o.status, o.count, o.error].filter((x) => x !== undefined).join(' '));
    if (outcomes.some((o) => o.status === 'failed')) process.exitCode = 1;
  }
}
