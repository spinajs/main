import { QueueClient } from '@spinajs/Queue';
import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { User } from '../models/User';
import { UserRoleRevoked } from '../events/UserRoleRevoked';
import { ResourceNotFound } from '@spinajs/exceptions';
import _ from 'lodash';

@Command('rbac:user-revoke', 'Sets active or inactive user')
@Argument('idOrUuid', 'numeric id or uuid')
@Argument('role', 'user role')
export class RevokeUserRole extends CliCommand {
  @Logger('rbac')
  protected Log: Log;

  @Autoinject(QueueClient)
  protected Queue: QueueClient;

  public async execute(idOrUuid: string, role: string): Promise<void> {
    const result = await User.where('Id', idOrUuid).orWhere('Uuid', idOrUuid).firstOrThrow(new ResourceNotFound('User with given id or uuid not found in db'));

    result.Role = _.remove(result.Role, role);

    await result.update();

    this.Queue.emit(new UserRoleRevoked(idOrUuid, role));

    this.Log.success(`User role revoked !`);
  }
}
