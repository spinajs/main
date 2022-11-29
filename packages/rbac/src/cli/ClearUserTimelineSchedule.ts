import { Log, Logger } from '@spinajs/log';
import { CliCommand, Command } from '@spinajs/cli';
import { Config } from '@spinajs/configuration';
import { CronJob } from 'cron';
import { UserAction } from '../models/UserTimeline';
import { DateTime } from 'luxon';

@Command('rbac:cleanup-schedule', 'Starts a schedule with cleanup tasks')
export class ChangeUserPassword extends CliCommand {
  @Logger('rbac')
  protected Log: Log;

  @Config('rbac.timeline.schedule')
  protected CronSchedule: string;

  @Config('rbac.timeline.ttl')
  protected TimelineTTL: number;

  public async execute(): Promise<void> {
    new CronJob(
      this.CronSchedule,
      async () => {
        const result = await UserAction.destroy()
          .where('Persistent', false)
          .andWhere(
            'CreatedAt',
            '<=',
            DateTime.now().plus({
              minutes: -this.TimelineTTL,
            }),
          );

        if (result && result.RowsAffected > 0) {
          this.Log.info(`Deleted ${result.RowsAffected} user timeline events`);
        } else {
          this.Log.info(`No user timeline events do delete this time`);
        }
      },
      () => {
        this.Log.info('rbac:cleanup-schedule stopped');
      },
      true,
    );

    this.Log.success(`User password changed !`);
  }
}
