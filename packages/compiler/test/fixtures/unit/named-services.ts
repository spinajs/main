import { AutoinjectNamedService, AutoinjectNamedServices } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';

export abstract class Channel {}
export abstract class Step {}
export abstract class AuditStep extends Step {}

@Injectable()
export class Notifier {
  @AutoinjectNamedService('notify.channel', Channel, { default: 'MailChannel' })
  protected Channel: Channel;

  @AutoinjectNamedService('notify.fallback', Channel, { optional: true })
  protected Fallback?: Channel;

  @AutoinjectNamedServices('notify.steps', Step, { lineage: true, keyBy: 'name' })
  protected Steps: Map<string, Step>;

  @AutoinjectNamedServices('notify.audit', AuditStep, { lineage: true, keyBy: 'name' })
  protected Audit: Map<string, Step>;
}
