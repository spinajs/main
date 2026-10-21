import type { IdentityRef } from '@spinajs/authn/contracts';
import { MfaEnrolmentMarks } from '@spinajs/authn/contracts';
import { Autoinject, Injectable, PerChildInstance } from '@spinajs/di';

import { DbMfaStore } from './db-mfa-store.js';

/** What the row holds in place of a secret: the store keeps cipher text, and a mark has nothing to hide. */
const MARK_SECRET = 'mark';
const MARK_KEY = 'none';

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

  public async has(id: IdentityRef, step: string): Promise<boolean> {
    const row = await this.store().get(id, step);
    return row !== null && row.confirmedAt !== null;
  }

  /** True for exactly the call that confirmed the row; false when the identity is marked already. */
  public async mark(id: IdentityRef, step: string): Promise<boolean> {
    const store = this.store();
    if (!(await store.putPending(id, step, MARK_SECRET, MARK_KEY))) return false;
    return store.confirm(id, step, new Date(), MARK_SECRET);
  }

  public async unmark(id: IdentityRef, step: string): Promise<void> {
    await this.store().remove(id, step);
  }

  private store(): DbMfaStore {
    return this.db ?? this.DbMfaStore;
  }
}
