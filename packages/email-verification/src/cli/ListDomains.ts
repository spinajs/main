/* eslint-disable no-console */
import { CliCommand, Command, Option } from '@spinajs/cli';
import { AutoinjectService } from '@spinajs/configuration';
import { EmailVerificationStore } from '../contracts.js';
import { kindArg } from './common.js';

/** Prints `<kind> <source> <domain>` per entry to stdout: a report, not log output. */
@Command('email-verification:list', 'Prints the stored list entries')
@Option('--kind <kind>', false, 'block, allow or block-mx')
@Option('--source <source>', false, 'only this list source')
export class ListDomains extends CliCommand {
  @AutoinjectService('emailVerification.store', EmailVerificationStore)
  protected Store: EmailVerificationStore;

  public async execute(options: { kind?: string; source?: string }): Promise<void> {
    const kind = options.kind === undefined ? undefined : kindArg(options.kind);
    const lines = (await this.Store.loadLists())
      .filter((e) => (kind === undefined || e.kind === kind) && (options.source === undefined || e.source === options.source))
      .map((e) => `${e.kind} ${e.source} ${e.domain}`)
      .sort();
    for (const line of lines) console.log(line);
  }
}
