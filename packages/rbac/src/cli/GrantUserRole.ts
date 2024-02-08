import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { Commands } from '../models/User.js';
import { ResourceNotFound } from '@spinajs/exceptions';
import _ from 'lodash';

@Command('rbac:user-grant', 'Grants role to user')
@Argument('idOrUuid', 'numeric id or uuid')
@Argument('role', 'user role')
export class GrantUserRole extends CliCommand {
  @Logger('rbac')
  protected Log: Log;

  public async execute(idOrUuid: string, role: string): Promise<void> {
    try {
      await Commands.grant(idOrUuid, role);
      this.Log.success(`Role ${role} granted to user ${idOrUuid}`);
    } catch (e) {
      if (e instanceof ResourceNotFound) {
        this.Log.error(`User ${idOrUuid} not found`);
      } else {
        this.Log.error(`Error while granting role ${role} to user ${idOrUuid} ${e.message}`);
      }
    }
  }
}
