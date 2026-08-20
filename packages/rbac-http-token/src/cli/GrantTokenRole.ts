import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command } from '@spinajs/cli';

import { grantTokenRole } from '../actions.js';

@Command('rbac:token-grant', 'Grants a role to an access token')
@Argument('uuid', true, 'token uuid')
@Argument('role', true, 'role to grant, must be allowed for the token owner by the configured role policy')
export class GrantTokenRole extends CliCommand {
  @Logger('rbac-http-token')
  protected Log: Log;

  public async execute(uuid: string, role: string): Promise<void> {
    try {
      await grantTokenRole(uuid, role);
      this.Log.success(`Role ${role} granted to token ${uuid}`);
    } catch (e) {
      this.Log.error(`Error while granting role ${role} to token ${uuid}: ${(e as Error).message}`);
    }
  }
}
