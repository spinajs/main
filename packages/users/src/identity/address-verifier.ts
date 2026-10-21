import { Injectable } from '@spinajs/di';
import { IdentityAddressVerifier } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';

/** Records a verified address on the users row (`EmailVerifiedAt`). */
@Injectable(IdentityAddressVerifier)
export class UserAddressVerifier extends IdentityAddressVerifier {
  public async markVerified(_id: IdentityRef, _at: Date): Promise<void> {
    throw new Error('not implemented: markVerified');
  }
}
