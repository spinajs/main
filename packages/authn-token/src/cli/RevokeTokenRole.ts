import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command } from '@spinajs/cli';

import { revokeTokenRole } from '../actions.js';

@Command('rbac:token-revoke', 'Revokes a role from an access token')
@Argument('uuid', true, 'token uuid')
@Argument('role', true, 'role to revoke')
export class RevokeTokenRole extends CliCommand {
  @Logger('rbac-http-token')
  protected Log: Log;

  /**
   * Refusals arrive as thrown errors ( eg. revoking a token's last role ) and
   * are reported on the error channel like any other failure - the row is left
   * exactly as it was.
   */
  public async execute(uuid: string, role: string): Promise<void> {
    try {
      await revokeTokenRole(uuid, role);
      this.Log.success(`Role ${role} revoked from token ${uuid}`);
    } catch (e) {
      this.Log.error(`Error while revoking role ${role} from token ${uuid}: ${(e as Error).message}`);
    }
  }
}
