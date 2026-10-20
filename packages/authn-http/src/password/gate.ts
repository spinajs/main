import { PasswordService } from '@spinajs/authn/contracts';

import { serviceRegistered } from '../policies/v3/groups.js';

/** 404 while no PasswordService is registered: the password routes are off (design §22.11). The first policy of the controller. */
export class PasswordServiceRegistered extends serviceRegistered(PasswordService, 'the password routes are off: no PasswordService is registered') {}
