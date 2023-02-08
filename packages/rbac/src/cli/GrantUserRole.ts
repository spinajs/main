import { QueueClient } from '@spinajs/Queue';
import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { User } from '../models/User.js';
import { UserRoleGranted } from '../events/UserRoleGranted.js';
import { ResourceNotFound } from '@spinajs/exceptions';
import _ from 'lodash';

@Command('rbac:user-grant', 'Grants role to user')
@Argument('idOrUuid', 'numeric id or uuid')
@Argument('role', 'user role')
export class GrantUserRole extends CliCommand {
  @Logger('rbac')
  protected Log: Log;

  @Autoinject(QueueService)
  protected Queue: QueueService;

  public async execute(idOrUuid: string, role: string): Promise<void> {
    const result = await User.where('Id', idOrUuid).orWhere('Uuid', idOrUuid).firstOrThrow(new ResourceNotFound('User with given id or uuid not found in db'));

    result.Role.push(role);
    result.Role = _.uniq(result.Role);

    await result.update();

    this.Queue.emit(new UserRoleGranted(idOrUuid, role));

    this.Log.success(`User role granted !`);
  }
}
