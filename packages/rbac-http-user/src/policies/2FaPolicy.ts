import { InvalidOperation } from '@spinajs/exceptions';
import { Config } from '@spinajs/configuration';
import { BasePolicy, Request as sRequest } from '@spinajs/http';
import { TwoFactorAuthConfig } from '@spinajs/rbac-http';
import { Forbidden } from '@spinajs/exceptions';


export class TwoFacRouteEnabled extends BasePolicy {
  @Config('rbac.twoFactorAuth')
  protected TwoFactorConfig: TwoFactorAuthConfig;

  public isEnabled(): boolean {
    return true;
  }
  public execute(req: sRequest): Promise<void> {
    if (this.TwoFactorConfig.enabled === false) {
      throw new InvalidOperation('2 factor auth is not enabled');
    }
    

    /**
     * Check only if user passed login page and waiting for TwoFactorAuth
     */
    if (!req.storage.Session?.Data.get('TwoFactorAuth')) {
      throw new Forbidden('user does not have 2fa enabled');
    }


    return Promise.resolve();
  }
}
