import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { Config } from '@spinajs/configuration';
import { UserTimeline } from '../models/UserTimeline';
import { DateTime } from 'luxon';
import { User } from '../models/User';

@Command('rbac:user-events', 'Shows latest user timelinet events')
@Argument('idOrUuid', 'numeric id or uuid')
export class ChangeUserPassword extends CliCommand {
  @Logger('console')
  protected Log: Log;

  public async execute(idOrUuid: string): Promise<void> {
    const user = await User.where('Id', idOrUuid)
      .orWhere('Uuid', idOrUuid)
      .firstOrThrow(new Error(`No user with id ${idOrUuid}`));

    const timeline = await UserTimeline.where({ User: user });

    timeline.forEach((x) => {
      this.Log.info(`Event ${x.Action}, date: ${x.CreatedAt.toISO()}, persistent: ${x.Persistent}, data: ${x.Data}`);
    });
  }
}
