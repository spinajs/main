import { TokenService } from '@spinajs/authn/contracts';

import { serviceRegistered } from '../policies/v3/groups.js';

/**
 * 404 while no TokenService is registered: the 3.0 token routes are off (design §22.11). The first policy of the
 * controller. Not exported by the package barrel.
 */
export class TokenServiceRegistered extends serviceRegistered(TokenService, 'the token routes are off: no TokenService is registered') {}
