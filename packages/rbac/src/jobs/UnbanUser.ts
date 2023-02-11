import { Autoinject } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { Job, QueueService, QueueJob } from '@spinajs/queue';
import { UserUnbanned } from '../events/index.js';
import { User } from '../models/User.js';

@Job()
export class UnbanUser extends QueueJob {
  @Logger('rbac')
  protected Log: Log;

  @Autoinject(QueueService)
  protected Queue: QueueService;

  constructor(public UserUUID: string) {
    super();
  }

  public async execute() {
    const user = await User.where('Id', this.UserUUID).orWhere('Uuid', this.UserUUID).firstOrThrow(new Error('User not found'));
    user.IsBanned = false;

    await user.update();
    await user.Metadata.delete(/user:ban.*/);
    await this.Queue.emit(new UserUnbanned(this.UserUUID));
  }
}
