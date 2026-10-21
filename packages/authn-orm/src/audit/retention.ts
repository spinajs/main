import { AsyncService, Injectable, PerChildInstance } from '@spinajs/di';
import { Config } from '@spinajs/configuration';

/**
 * Deletes `authn_audit` rows older than `authn.audit.retentionDays`, in batches, on `purge` and, when
 * `authn.audit.purgeInterval` (ms) is set, on a timer. Both keys are off (null) by default: audit rows are kept forever.
 */
@PerChildInstance()
@Injectable()
export class AuthnAuditRetention extends AsyncService {
  @Config('authn.audit.retentionDays')
  protected RetentionDays: number | null | undefined;

  @Config('authn.audit.purgeInterval')
  protected PurgeInterval: number | null | undefined;

  public async purge(_now: Date = new Date()): Promise<number> {
    throw new Error('not implemented: AuthnAuditRetention.purge');
  }
}
