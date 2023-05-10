import { InvalidOperation } from '@spinajs/exceptions';
import { Config } from '@spinajs/configuration';
import { BasePolicy } from '@spinajs/http';

export class AllowFederatedLoginPolicy extends BasePolicy {
  @Config('rbac.allowFederated')
  protected allowFeredatedLogin: boolean;

  public isEnabled(): boolean {
    return true;
  }
  public execute(): Promise<void> {
    if (!this.allowFeredatedLogin) {
      throw new InvalidOperation('federated login is not enabled');
    }

    return Promise.resolve();
  }
}
