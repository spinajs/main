import { Log, Logger } from '@spinajs/log';
import { Argument, Command } from '@spinajs/cli';
import { RbacCliCommand } from './RbacCliCommand.js';
import { ResourceNotFound } from '@spinajs/exceptions';
import _ from 'lodash';
import { revoke } from '../actions.js';

@Command('rbac:user-revoke', 'Revokes role from user')
@Argument('idOrUuid',true, 'numeric id or uuid')
@Argument('role',true, 'user role')
export class RevokeUserRole extends RbacCliCommand {
  @Logger('rbac')
  protected Log: Log;

  public async execute(idOrUuid: string, role: string): Promise<void> {
    try {

      await revoke(idOrUuid, role);

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
