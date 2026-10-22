import { Argument, CliCommand, Command, Option } from '@spinajs/cli';
import { AutoinjectService } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { ADMIN_SOURCE, EmailVerificationStore } from '../contracts.js';
import { domainsArg, kindArg } from './common.js';

@Command('email-verification:unlist', 'Removes domains from one list')
@Argument({ name: 'domains', required: true, variadic: true, description: 'domains to remove' })
@Option('--kind <kind>', true, 'block, allow or block-mx')
@Option('--source <source>', false, 'list source, default admin')
export class UnlistDomains extends CliCommand {
  @Logger('email-verification')
  protected Log: Log;

  @AutoinjectService('emailVerification.store', EmailVerificationStore)
  protected Store: EmailVerificationStore;

  public async execute(domains: string[], options: { kind: string; source?: string }): Promise<void> {
    const kind = kindArg(options.kind);
    const list = domainsArg(domains);
    await this.Store.removeEntries(kind, list, options.source ?? ADMIN_SOURCE);
    this.Log.success({ count: list.length, kind }, 'Removed ${count} domain(s) from ${kind}');
  }
}
