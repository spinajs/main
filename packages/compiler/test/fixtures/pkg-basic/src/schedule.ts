import { Schedule, ScheduledTask } from '@spinajs/scheduler';
import { Job, QueueJob } from '@spinajs/queue';

@Job({ runAs: 'system' })
export class Cleanup extends QueueJob { public olderThanDays: number; public async execute(): Promise<void> {} }

@Schedule('cleanup', { cron: '0 3 * * *', timezone: 'UTC', runOn: 'leader', emit: Cleanup })
export class CleanupSchedule extends ScheduledTask {}
