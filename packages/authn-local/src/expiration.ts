import { DI, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { PasswordCredentialStore, PasswordService } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';

import type { AuditLog } from './audit.js';
import { EXPIRED_PASSWORD_MARKER } from './hasher.js';

const DAY_MS = 86_400_000;

/** Knows when each password was set; @spinajs/users implements it. */
export abstract class PasswordAgeSource {
  public abstract passwordsSetBefore(cutoff: Date): Promise<readonly IdentityRef[]>;
}

export interface PasswordExpirationResult {
  /** Set when the job did nothing: it is disabled, or no `PasswordAgeSource` is registered. */
  readonly idle?: 'disabled' | 'no_source';
  readonly expired: number;
  /** Already holding the expiry marker. */
  readonly skipped: number;
  readonly failed: number;
}

export interface PasswordExpirationJobDeps {
  /** null: none registered. */
  readonly ages: PasswordAgeSource | null;
  readonly passwords: PasswordCredentialStore;
  readonly service: PasswordService;
  /** `authn.local.expiration.enabled`; default false. */
  readonly enabled?: boolean;
  /** `authn.local.expiration.maxAgeDays`; default 31. */
  readonly maxAgeDays?: number;
  readonly log?: AuditLog;
}

/**
 * Expires every password set more than `maxAgeDays` ago (D16, A30) with cause `aged`. Runs only when called (the
 * `authn:password-expire` command); apps schedule it.
 */
@Injectable()
export class PasswordExpirationJob {
  // Code defaults: @spinajs/users still ships `authn.local.expiration` with its 2.x keys.
  @Config('authn.local.expiration.enabled', { defaultValue: false })
  protected Enabled: boolean;

  @Config('authn.local.expiration.maxAgeDays', { defaultValue: 31 })
  protected MaxAgeDays: number;

  @Logger('authn-local')
  protected Log: Log;

  constructor(protected readonly Deps?: PasswordExpirationJobDeps) {}

  public async run(now: Date = new Date()): Promise<PasswordExpirationResult> {
    if (!(this.Deps ? (this.Deps.enabled ?? false) : this.Enabled)) {
      return { idle: 'disabled', expired: 0, skipped: 0, failed: 0 };
    }
    const maxAgeDays = this.Deps ? (this.Deps.maxAgeDays ?? 31) : this.MaxAgeDays;
    if (typeof maxAgeDays !== 'number' || !Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
      throw new InvalidOption(`authn.local.expiration.maxAgeDays must be a positive number of days, got ${String(maxAgeDays)}`);
    }

    const ages = await this.ages();
    if (!ages) {
      this.log().warn('No PasswordAgeSource is registered: no password was expired');
      return { idle: 'no_source', expired: 0, skipped: 0, failed: 0 };
    }

    const passwords = this.passwords();
    const service = await this.service();
    const counts = { expired: 0, skipped: 0, failed: 0 };
    for (const id of await ages.passwordsSetBefore(new Date(now.getTime() - maxAgeDays * DAY_MS))) {
      try {
        if ((await passwords.get(id)) === EXPIRED_PASSWORD_MARKER) {
          counts.skipped++;
          continue;
        }
        await service.expire(id, { cause: 'aged' }, { now, purpose: 'request' });
        counts.expired++;
      } catch (err) {
        counts.failed++;
        // The name only: a store error may carry the hash in its message.
        this.log().warn(`Could not expire the password of ${id.type} ${id.id}: ${(err as Error)?.name ?? typeof err}`);
      }
    }
    return counts;
  }

  protected async ages(): Promise<PasswordAgeSource | null> {
    if (this.Deps) {
      return this.Deps.ages;
    }
    return DI.check(PasswordAgeSource) ? await DI.resolve(PasswordAgeSource) : null;
  }

  protected passwords(): PasswordCredentialStore {
    return this.Deps ? this.Deps.passwords : DI.resolve(PasswordCredentialStore);
  }

  protected async service(): Promise<PasswordService> {
    return this.Deps ? this.Deps.service : await DI.resolve(PasswordService);
  }

  protected log(): AuditLog {
    return this.Deps ? (this.Deps.log ?? { warn: () => undefined }) : this.Log;
  }
}
