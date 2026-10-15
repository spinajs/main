import { Argument, Command, Option } from '@spinajs/cli';
import { SchedulerCommand } from '../cli-support/SchedulerCommand.js';

@Command('scheduler:pause', 'Pauses scheduled runs of a schedule (manual runs still work unless --hard)')
@Argument('name', true, 'schedule name')
@Option('--hard', false, 'also refuse manual runs')
@Option('--json', false, 'print JSON')
export class SchedulerPauseCommand extends SchedulerCommand {
  public async execute(name: string, options: { hard?: boolean; json?: boolean }): Promise<void> {
    await this.guard(!!options.json, async () => {
      const info = await (await this.service()).pause(name, { hard: !!options.hard, triggeredBy: this.principal() });
      return options.json ? this.json(info) : this.print(`paused ${name}${info.hardPaused ? ' (hard)' : ''}`);
    });
  }
}
