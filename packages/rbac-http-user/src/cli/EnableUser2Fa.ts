import { Log, Logger } from '@spinajs/log';
import { Argument, Command } from '@spinajs/cli';
import { RbacCliCommand } from '@spinajs/rbac';
import { AutoinjectService } from '@spinajs/configuration';
import { TwoFactorAuthProvider } from "@spinajs/rbac-http";
import { enableUser2Fa } from "../actions/2fa.js";

import "../2fa/Default2FaToken.js";

@Command('rbac:user-enable-2fa', 'Sets active 2fa for user ( generate secret ')
@Argument('idOrUuid', true, 'numeric id or uuid')
export class EnableUser2Fa extends RbacCliCommand {
  @Logger('rbac-http-user')
  protected Log: Log;

  @AutoinjectService('rbac.twoFactorAuth')
  protected TwoFa: TwoFactorAuthProvider;

  public async execute(idOrUuid: string): Promise<void> {
    const result = await enableUser2Fa(idOrUuid);
    this.Log.success(`2fa enabled for user ${idOrUuid}, otp: ${result}`);
  }
}
