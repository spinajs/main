import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { Commands } from '../models/User.js';
import { ResourceNotFound } from '@spinajs/exceptions';
import _ from 'lodash';

@Command('rbac:user-revoke', 'Sets active or inactive user')
@Argument('idOrUuid', 'numeric id or uuid')
@Argument('role', 'user role')
export class RevokeUserRole extends CliCommand {
  @Logger('rbac')
  protected Log: Log;

  public async execute(idOrUuid: string, role: string): Promise<void> {
    try {
      await Commands.revoke(idOrUuid, role);
      this.Log.success(`Role ${role} revoked from user ${idOrUuid}`);
    } catch (e) {
      if (e instanceof ResourceNotFound) {
        this.Log.error(`User ${idOrUuid} not found`);
      } else {
        this.Log.error(`Error while revoking role ${role} from user ${idOrUuid} ${e.message}`);
      }
    }
  }
}
