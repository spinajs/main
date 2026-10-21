import type { IController, IRoute, Request } from '@spinajs/http';
import { PasswordService } from '@spinajs/authn/contracts';

import { serviceRegistered } from '../policies/v3/groups.js';
import { notFound } from '../policies/v3/errors.js';

/** 404 while no PasswordService is registered: the password routes are off (design §22.11). The first policy of the controller. */
export class PasswordServiceRegistered extends serviceRegistered(PasswordService, 'the password routes are off: no PasswordService is registered') {}

/** 404 also while the PasswordService cannot send login codes (its method is optional). */
export class CodeLoginRegistered extends PasswordServiceRegistered {
  public async execute(req: Request, action: IRoute, instance: IController): Promise<void> {
    await super.execute(req, action, instance);
    const passwords = await this.Container.resolve(PasswordService);
    if (typeof passwords.requestCode !== 'function') {
      throw notFound('not_found', 'code login is off: the PasswordService sends no codes');
    }
  }
}

/** 404 also while the PasswordService offers no address verification (its methods are optional). */
export class AddressVerificationRegistered extends PasswordServiceRegistered {
  public async execute(req: Request, action: IRoute, instance: IController): Promise<void> {
    await super.execute(req, action, instance);
    const passwords = await this.Container.resolve(PasswordService);
    if (typeof passwords.requestVerification !== 'function' || typeof passwords.redeemVerification !== 'function') {
      throw notFound('not_found', 'address verification is off: the PasswordService offers none');
    }
  }
}
