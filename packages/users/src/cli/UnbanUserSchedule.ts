import { Log, Logger } from '@spinajs/log';
import { CliCommand, Command } from '@spinajs/cli';
import { Config } from '@spinajs/configuration';
import { CronJob } from 'cron';

@Command('rbac:unban-schedule', 'Starts a schedule that automatically unbabns users')
export class UnbanUserSchedule extends CliCommand {
  @Logger('rbac')
  protected Log: Log;

  @Config('rbac.timeline.schedule')
  protected CronSchedule: string;

  @Config('rbac.timeline.ttl')
  protected TimelineTTL: number;

  public async execute(): Promise<void> {
    new CronJob(
      this.CronSchedule,
      async () => {},
      () => {
        this.Log.info('rbac:cleanup-schedule stopped');
      },
      true,
    );

    this.Log.success(`User password changed !`);
  }
}
