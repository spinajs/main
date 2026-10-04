import type { Principal } from '@spinajs/authz';
import type { User } from '../models/User.js';

/**
 * Derives principal attributes from the user record (an app's `pool`, for example). Register one with
 * `@Injectable(PrincipalAttributeProvider)`; `UserPrincipalFactory` asks every registered provider, in
 * registration order. Keys a provider returns win over the attributes a strategy asserted
 * (`StrategyOutcome.attributes`, design §18.3(e)) and over the keys of providers asked before it.
 */
export abstract class PrincipalAttributeProvider {
  /**
   * @param user - the user the principal speaks for, metadata populated when the factory loaded it
   * @param principal - the principal built so far, with the attributes merged before this provider
   */
  public abstract attributes(user: User, principal: Principal): Promise<Readonly<Record<string, unknown>>>;
}
