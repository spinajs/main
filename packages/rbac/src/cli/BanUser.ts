import { UserUnbanned } from './../events/UserUnbanned.js';
import { QueueService } from '@spinajs/Queue';
import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { User } from '../models/User.js';
import { UserBanned } from '../events/UserBanned.js';
import { UserMetadata } from '../models/UserMetadata.js';
import { UnbanUser } from '../jobs/UnbanUser.js';
import { DateTime } from 'luxon';

@Command('rbac:user-ban', 'Sets active or inactive user')
@Argument('idOrUuid', 'numeric id or uuid')
@Argument('ban', ' true / false', false, (opt: string) => (opt.toLowerCase() === 'true' ? true : false))
@Argument('duration', 'how long should ban last ( in minutes )', 24 * 60, (opt: string) => parseInt(opt))
export class BanUser extends CliCommand {
  @Logger('rbac')
  protected Log: Log;

  @Autoinject(QueueService)
  protected Queue: QueueService;

  public async execute(idOrUuid: string, ban: boolean, duration: number): Promise<void> {
    const user = await User.where('Id', idOrUuid).orWhere('Uuid', idOrUuid).firstOrThrow(new Error('User not found'));
    user.IsBanned = ban;

    await user.update();

    if (ban) {
      await (user.Metadata['ban:duration'] = duration);
      await (user.Metadata['ban:issued'] = DateTime.now().toISO());

      this.Queue.emit(new UserBanned(idOrUuid, duration));

      if (duration !== 0) {
        // schedule job with delay equals ban duration
        // to automattically unban user after this time
        const job = new UnbanUser(idOrUuid);
        job.ScheduleDelay = duration * 60 * 1000;

        this.Queue.emit(job);
      }

      this.Log.success(`User ban status changed to ${ban}`);
    } else {
      // cleanup meta
      await UserMetadata.destroy().where('Key', 'like', 'user:ban:%').andWhere('User', user);

      this.Queue.emit(new UserUnbanned(idOrUuid));
      this.Log.warn(`No user with id: ${idOrUuid} found`);
    }
  }
}
