import { Autoinject } from '@spinajs/di';
import { CliCommand, Command } from '@spinajs/cli';

import { AuthnAuditRetention } from '../audit/retention.js';

/** Housekeeping for a scheduler (cron, worker); a no-op while `authn.audit.retentionDays` is unset. */
@Command('authn:audit-purge', 'Deletes audit rows older than authn.audit.retentionDays')
export class PurgeAudit extends CliCommand {
  @Autoinject(AuthnAuditRetention)
  protected Retention: AuthnAuditRetention;

  public async execute(): Promise<void> {
    throw new Error('not implemented: PurgeAudit.execute');
  }
}
