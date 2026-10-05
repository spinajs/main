import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BasePolicy } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';
import type { TotpService } from '@spinajs/authn-totp/service';

import { notFound } from '../policies/v3/errors.js';

/**
 * The DI key of authn-totp's TotpService (`@Injectable()` registers a class under its name). Only its type is imported:
 * loading the class loads TotpMfaStep, which registers itself as an MfaStep, and scanning these routes must not do that.
 */
export const TOTP_SERVICE = 'TotpService';

export const totpServiceOf = async (container: IContainer): Promise<TotpService> => await container.resolve<TotpService>(TOTP_SERVICE);

/** 404 while no TotpService is registered: the MFA enrolment routes are off (design §22.11). The first policy of the controller. */
export class TotpServiceRegistered extends BasePolicy {
  @Autoinject(Container)
  protected Container!: IContainer;

  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(_req: Request, _action: IRoute, _instance: IController): Promise<void> {
    if (!this.Container.hasRegistered(TOTP_SERVICE)) throw notFound('not_found', 'the MFA enrolment routes are off: no TotpService is registered');
  }
}
