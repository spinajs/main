import { Argument, Command, Option } from '@spinajs/cli';
import { when } from '../cli-support/format.js';
import { SchedulerCommand } from '../cli-support/SchedulerCommand.js';

@Command('scheduler:resume', 'Resumes a paused schedule and resets its failure count')
@Argument('name', true, 'schedule name')
@Option('--json', false, 'print JSON')
export class SchedulerResumeCommand extends SchedulerCommand {
  public async execute(name: string, options: { json?: boolean }): Promise<void> {
    await this.guard(!!options.json, async () => {
      const info = await (await this.service()).resume(name, { triggeredBy: this.principal() });
      return options.json ? this.json(info) : this.print(`resumed ${name}; next run ${when(info.nextRunAt)}`);
    });
  }
}
