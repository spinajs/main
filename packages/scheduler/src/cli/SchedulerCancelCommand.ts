import { Argument, Command, Option } from '@spinajs/cli';
import { SchedulerCommand } from '../cli-support/SchedulerCommand.js';

@Command('scheduler:cancel', 'Cancels a queued, retrying or running run')
@Argument('id', true, 'run id')
@Option('--json', false, 'print JSON')
export class SchedulerCancelCommand extends SchedulerCommand {
  public async execute(id: string, options: { json?: boolean }): Promise<void> {
    await this.guard(!!options.json, async () => {
      const run = await (await this.service()).cancel(id, { triggeredBy: this.principal() });
      if (options.json) return this.json(run);
      this.print(
        run.status === 'running'
          ? `cancel requested for run ${id}; the holder stops at its next heartbeat`
          : `run ${id} ${run.status}`,
      );
    });
  }
}
