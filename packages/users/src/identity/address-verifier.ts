import { Autoinject, Injectable } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import { IdentityAddressVerifier } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';

import { runAsSystem } from '../system.js';
import { recordAddressVerifiedAt } from './sql.js';

/**
 * Records a verified address on the users row (`EmailVerifiedAt`), as SYSTEM: the verify link is redeemed anonymously.
 * An identity that is no user, or no row, changes nothing.
 */
@Injectable(IdentityAddressVerifier)
export class UserAddressVerifier extends IdentityAddressVerifier {
  /** Never read: injecting it resolves the Orm, which binds the `User` model, before the first query. */
  @Autoinject(Orm)
  protected Orm: Orm;

  public async markVerified(id: IdentityRef, at: Date): Promise<void> {
    if (id?.type !== 'user' || typeof id.id !== 'string') {
      return;
    }
    await runAsSystem('address-verifier', () => recordAddressVerifiedAt(id.id, at));
  }
}
