import { CliCommand, Command } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { Logger, Log } from '@spinajs/log-common';
import { QueueService } from '@spinajs/queue';
import { LazyUploadJob } from '../job.js';

@Command('fs-lazy:process', 'Process lazy file upload')
export class ProcessFiles extends CliCommand {
  @Logger('fs-lazy')
  protected Log: Log;

  @Autoinject()
  protected Queue: QueueService;

  public async execute(): Promise<void> {
    this.Log.success(`Start processing lazy file upload ...`);
    await this.Queue.consume(LazyUploadJob);

    // consume() returns once subscribed and @spinajs/cli exits the process when execute() resolves
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });

    await this.Queue.stopConsuming(LazyUploadJob);
  }
}
