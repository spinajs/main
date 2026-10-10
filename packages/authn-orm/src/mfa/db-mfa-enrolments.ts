import type { IdentityRef } from '@spinajs/authn/contracts';
import { MfaEnrolments } from '@spinajs/authn/mfa-enrolments';
import { DI, Injectable, Singleton } from '@spinajs/di';

import { DbMfaStore } from './db-mfa-store.js';

/** The confirmed steps of `authn_mfa` for DefaultMfaPolicy and authn:check-config, whether authn.mfa.steps lists them or not. */
@Singleton()
@Injectable(MfaEnrolments)
export class DbMfaEnrolments extends MfaEnrolments {
  private resolved: DbMfaStore | undefined;

  /** DI passes nothing: `DbMfaStore` is resolved from DI on first use. */
  constructor(private readonly db?: DbMfaStore) {
    super();
  }

  private store(): DbMfaStore {
    return (this.resolved ??= this.db ?? DI.resolve(DbMfaStore));
  }

  public stepsOf(id: IdentityRef): Promise<readonly string[]> {
    return this.store().confirmedSteps(id);
  }

  public stepNames(): Promise<readonly string[]> {
    return this.store().confirmedStepNames();
  }
}
