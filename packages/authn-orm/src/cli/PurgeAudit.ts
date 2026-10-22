import { Autoinject } from '@spinajs/di';
import { CliCommand, Command } from '@spinajs/cli';
import { Log, Logger } from '@spinajs/log';
import { OrmMigrator } from '@spinajs/orm';

import { AuthnAuditRetention } from '../audit/retention.js';

/** Housekeeping for a scheduler (cron, worker); a no-op while `authn.audit.retentionDays` is unset. */
@Command('authn:audit-purge', 'Deletes audit rows older than authn.audit.retentionDays')
export class PurgeAudit extends CliCommand {
  @Logger('authn-orm')
  protected Log: Log;

  /** The cli resolves only the command, so the command runs the `Migration.OnStartup` pass an app process runs before serving. */
  @Autoinject(OrmMigrator)
  protected Migrator: OrmMigrator;

  @Autoinject(AuthnAuditRetention)
  protected Retention: AuthnAuditRetention;

  public async execute(): Promise<void> {
    try {
      if (!this.Retention.Enabled) {
        this.Log.warn('authn.audit.retentionDays is not set, no audit rows were purged');
        return;
      }

      const count = await this.Retention.purge();
      this.Log.success({ count }, 'Deleted ${count} audit row(s) past retention');
    } catch (e) {
      this.Log.error({ error: e }, 'Error while purging audit rows');
      process.exitCode = 1;
    }
  }
}
