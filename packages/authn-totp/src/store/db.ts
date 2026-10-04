import type { IdentityRef } from '@spinajs/authn/contracts';
import { DbMfaStore } from '@spinajs/authn-orm';
import { DI, Injectable, Singleton } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { MfaSecretStore } from './store.js';
import type { MfaRecord } from './store.js';

/**
 * `MfaSecretStore` on authn-orm's `authn_mfa` and `authn_recovery_code` tables. Only the `@spinajs/authn-totp/db`
 * entry loads it, since loading authn-orm registers its migrations and DB defaults.
 */
@Singleton()
@Injectable(MfaSecretStore)
export class DbMfaSecretStore extends MfaSecretStore {
  private resolved: DbMfaStore | undefined;

  /** DI passes nothing: `DbMfaStore` is resolved from DI on first use. */
  constructor(private readonly db?: DbMfaStore) {
    super();
  }

  private store(): DbMfaStore {
    return (this.resolved ??= this.db ?? DI.resolve(DbMfaStore));
  }

  async get(id: IdentityRef, step: string): Promise<MfaRecord | null> {
    const row = await this.store().get(id, step);
    return row && Object.freeze({ ...row });
  }

  put(id: IdentityRef, step: string, secretEnc: string, keyId: string): Promise<boolean> {
    return this.store().putPending(id, step, secretEnc, keyId);
  }

  async confirm(id: IdentityRef, step: string, at?: Date, expectedSecretEnc?: string): Promise<boolean> {
    if (at !== undefined && !(at instanceof Date && Number.isFinite(at.getTime()))) {
      throw new InvalidArgument('DbMfaSecretStore.confirm: at must be a valid date');
    }
    if (expectedSecretEnc !== undefined) {
      return this.store().confirm(id, step, at, expectedSecretEnc);
    }
    // DbMfaStore confirms unconditionally without a cipher text; pin the row read here so a confirmed row stays false.
    const row = await this.store().get(id, step);
    return !!row && !row.confirmedAt && this.store().confirm(id, step, at, row.secretEnc);
  }

  acceptStep(id: IdentityRef, step: string, timeStep: number): Promise<boolean> {
    return this.store().acceptStep(id, step, timeStep);
  }

  remove(id: IdentityRef, step: string): Promise<void> {
    return this.store().remove(id, step);
  }

  replaceRecoveryCodes(id: IdentityRef, rawCodes: readonly string[]): Promise<void> {
    return this.store().replaceRecoveryCodes(id, rawCodes);
  }

  redeemRecoveryCode(id: IdentityRef, raw: string): Promise<boolean> {
    return this.store().redeemRecoveryCode(id, raw);
  }

  countRecoveryCodes(id: IdentityRef): Promise<number> {
    return this.store().countRecoveryCodes(id);
  }

  removeRecoveryCodes(id: IdentityRef): Promise<void> {
    return this.store().removeRecoveryCodes(id);
  }
}
