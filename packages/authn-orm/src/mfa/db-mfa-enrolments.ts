import type { IdentityRef } from '@spinajs/authn/contracts';
import { MfaEnrolments } from '@spinajs/authn/mfa-enrolments';
import { Autoinject, Injectable, PerChildInstance } from '@spinajs/di';

import { DbMfaStore } from './db-mfa-store.js';

/** The confirmed steps of `authn_mfa` for DefaultMfaPolicy and authn:check-config, whether authn.mfa.steps lists them or not. */
@PerChildInstance()
@Injectable(MfaEnrolments)
export class DbMfaEnrolments extends MfaEnrolments {
  @Autoinject(DbMfaStore)
  protected DbMfaStore: DbMfaStore;

  /** DI passes nothing and injects `DbMfaStore`. */
  constructor(private readonly db?: DbMfaStore) {
    super();
  }

  private store(): DbMfaStore {
    return this.db ?? this.DbMfaStore;
  }

  public stepsOf(id: IdentityRef): Promise<readonly string[]> {
    return this.store().confirmedSteps(id);
  }

  public stepNames(): Promise<readonly string[]> {
    return this.store().confirmedStepNames();
  }
}
