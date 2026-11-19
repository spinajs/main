import { CliCommand, Command } from '@spinajs/cli';
import { Job, QueueJob } from '@spinajs/queue';
import { Schedule, ScheduledTask } from '@spinajs/scheduler';

@Job({ tenancy: 'required' })
export class SendInvoice extends QueueJob { public async execute(): Promise<void> {} }

@Job({ tenancy: 'carry' })
export class Recount extends QueueJob { public async execute(): Promise<void> {} }

@Job({ tenancy: 'none' })
export class Purge extends QueueJob { public async execute(): Promise<void> {} }

@Job()
export class Notify extends QueueJob { public async execute(): Promise<void> {} }

@Schedule('close-day', { cron: '0 3 * * *', tenancy: 'each' })
export class CloseDay extends ScheduledTask {}

@Schedule('vacuum', { cron: '0 4 * * *', tenancy: 'none' })
export class Vacuum extends ScheduledTask {}

@Schedule('heartbeat', { every: '1m' })
export class Heartbeat extends ScheduledTask {}

@Command('billing:sync', 'Sync billing')
export class Sync extends CliCommand { public async execute(): Promise<void> {} }
