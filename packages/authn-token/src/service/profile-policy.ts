import { Injectable } from '@spinajs/di';
import type { IdentityRef } from '@spinajs/authn/contracts';

/** The profiles (2.x `Profile`, a role name) an owner may pin a token to; asked at create and on every validate. */
export abstract class TokenProfilePolicy {
  abstract allowedProfiles(owner: IdentityRef): Promise<readonly string[]>;
}

/** No token may be pinned to a profile, as in 2.x. */
@Injectable(TokenProfilePolicy)
export class NoTokenProfilesPolicy extends TokenProfilePolicy {
  public async allowedProfiles(_owner: IdentityRef): Promise<readonly string[]> {
    return [];
  }
}
