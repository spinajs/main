import { CliCommand, Command } from '@spinajs/cli';
import { Event, QueueEvent, QueueJob, QueueService } from '@spinajs/queue';
import { Schedule, ScheduledTask } from '@spinajs/scheduler';
import { Job, SystemTask } from './declarations.js';

@Job({ runAs: 'initiator', access: ['doc:update'] })
export class Reindex extends QueueJob { public async execute(): Promise<void> {} }

@Job({ runAs: 'system' })
@SystemTask('purges expired drafts of every tenant')
export class Sweep extends QueueJob { public async execute(): Promise<void> {} }

@Event()
export class DocSeen extends QueueEvent { public id: string }

export class Consumers {
  constructor(protected Queue: QueueService) {}

  public async start(): Promise<void> {
    await this.Queue.consume(DocSeen, async () => {});
    await this.Queue.consume(Sweep);
  }
}

@Schedule('nightly', { cron: '0 3 * * *' })
@SystemTask('nightly reindex')
export class Nightly extends ScheduledTask {}

@Command('docs:sync', 'Sync documents')
export class Sync extends CliCommand { public async execute(): Promise<void> {} }

@Event()
@SystemTask('mirrors every published document to the search index')
export class DocPublished extends QueueEvent { public id: string }

export class Indexer {
  constructor(protected Queue: QueueService) {}

  public async start(): Promise<void> {
    await this.Queue.consume(DocPublished, async () => {});
  }
}
