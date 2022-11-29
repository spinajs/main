import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { UserAction } from '../models/UserTimeline';
import { User } from '../models/User';

@Command('rbac:user-events', 'Shows latest user timelinet events')
@Argument('idOrUuid', 'numeric id or uuid')
@Argument('count', 'how many entries should we get', 10, (opt) => parseInt(opt))
export class LatestUserEvents extends CliCommand {
  @Logger('console')
  protected Log: Log;

  public async execute(idOrUuid: string, count: number): Promise<void> {
    const user = await User.where('Id', idOrUuid)
      .orWhere('Uuid', idOrUuid)
      .firstOrThrow(new Error(`No user with id ${idOrUuid}`));

    const timeline = await UserAction.where({ User: user }).take(count).orderByDescending('CreatedAt');

    timeline.forEach((x) => {
      this.Log.info(`Event ${x.Action}, date: ${x.CreatedAt.toISO()}, persistent: ${x.Persistent}, data: ${x.Data}`);
    });
  }
}
