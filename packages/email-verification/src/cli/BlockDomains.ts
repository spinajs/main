import { Argument, CliCommand, Command, Option } from '@spinajs/cli';
import { AutoinjectService } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { ADMIN_SOURCE, EmailVerificationStore } from '../contracts.js';
import { domainsArg } from './common.js';

@Command('email-verification:block', 'Adds domains to the admin block list')
@Argument({ name: 'domains', required: true, variadic: true, description: 'domains to block' })
@Option('--mx', false, 'block them as MX hosts of throwaway mail services instead of as email domains')
export class BlockDomains extends CliCommand {
  @Logger('email-verification')
  protected Log: Log;

  @AutoinjectService('emailVerification.store', EmailVerificationStore)
  protected Store: EmailVerificationStore;

  public async execute(domains: string[], options: { mx?: boolean }): Promise<void> {
    const kind = options.mx ? 'block-mx' : 'block';
    const list = domainsArg(domains);
    await this.Store.upsertEntries(list.map((domain) => ({ domain, kind, source: ADMIN_SOURCE })));
    this.Log.success({ count: list.length, kind }, 'Added ${count} domain(s) to ${kind}');
  }
}
