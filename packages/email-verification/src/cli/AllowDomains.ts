import { Argument, CliCommand, Command } from '@spinajs/cli';
import { AutoinjectService } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { ADMIN_SOURCE, EmailVerificationStore } from '../contracts.js';
import { domainsArg } from './common.js';

@Command('email-verification:allow', 'Adds domains to the admin allow list; an allow entry wins over every block')
@Argument({ name: 'domains', required: true, variadic: true, description: 'domains to allow' })
export class AllowDomains extends CliCommand {
  @Logger('email-verification')
  protected Log: Log;

  @AutoinjectService('emailVerification.store', EmailVerificationStore)
  protected Store: EmailVerificationStore;

  public async execute(domains: string[], _options: object): Promise<void> {
    const list = domainsArg(domains);
    await this.Store.upsertEntries(list.map((domain) => ({ domain, kind: 'allow', source: ADMIN_SOURCE })));
    this.Log.success({ count: list.length }, 'Allowed ${count} domain(s)');
  }
}
