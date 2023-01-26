import { InvalidOperation } from '../@spinajs/exceptions';
import { Config } from '@spinajs/configuration';
import { BasePolicy } from '@spinajs/http';
import { TwoFactorAuthConfig } from '../interfaces.js';

export class TwoFacRouteEnabled extends BasePolicy {
  @Config('rbac.twoFactorAuth')
  protected TwoFactorConfig: TwoFactorAuthConfig;

  public isEnabled(): boolean {
    return true;
  }
  public execute(): Promise<void> {
    if (this.TwoFactorConfig.enabled === false) {
      throw new InvalidOperation('2 factor auth is not enabled');
    }

    return Promise.resolve();
  }
}
