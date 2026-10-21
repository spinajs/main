import type { IdentityRef } from '@spinajs/authn/contracts';
import { MfaEnrolmentMarks } from '@spinajs/authn/contracts';
import { Autoinject, Injectable, PerChildInstance } from '@spinajs/di';

import { DbMfaStore } from './db-mfa-store.js';

/** Enrolment marks of steps without a secret of their own, as confirmed `authn_mfa` rows. */
@PerChildInstance()
@Injectable(MfaEnrolmentMarks)
export class DbMfaEnrolmentMarks extends MfaEnrolmentMarks {
  @Autoinject(DbMfaStore)
  protected DbMfaStore: DbMfaStore;

  /** DI passes nothing and injects `DbMfaStore`. */
  constructor(protected readonly db?: DbMfaStore) {
    super();
  }

  public async has(_id: IdentityRef, _step: string): Promise<boolean> {
    throw new Error('not implemented: DbMfaEnrolmentMarks.has');
  }

  public async mark(_id: IdentityRef, _step: string): Promise<boolean> {
    throw new Error('not implemented: DbMfaEnrolmentMarks.mark');
  }

  public async unmark(_id: IdentityRef, _step: string): Promise<void> {
    throw new Error('not implemented: DbMfaEnrolmentMarks.unmark');
  }
}
