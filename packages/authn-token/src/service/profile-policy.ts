import { Injectable } from '@spinajs/di';
import type { IdentityRef } from '@spinajs/authn/contracts';

/** The profiles (role names) an owner may pin a token to; asked at create by TokenProfileHook and on every validate. */
export abstract class TokenProfilePolicy {
  abstract allowedProfiles(owner: IdentityRef): Promise<readonly string[]>;
}

/** The default: no token may be pinned to a profile. */
@Injectable(TokenProfilePolicy)
export class NoTokenProfilesPolicy extends TokenProfilePolicy {
  public async allowedProfiles(_owner: IdentityRef): Promise<readonly string[]> {
    return [];
  }
}
