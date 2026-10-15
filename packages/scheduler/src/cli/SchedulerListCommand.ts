import { Command, Option } from '@spinajs/cli';
import { table, when } from '../cli-support/format.js';
import { SchedulerCommand } from '../cli-support/SchedulerCommand.js';

@Command('scheduler:list', 'Lists schedules with their next run, health and last run')
@Option('--json', false, 'print JSON')
export class SchedulerListCommand extends SchedulerCommand {
  public async execute(options: { json?: boolean }): Promise<void> {
    await this.guard(!!options.json, async () => {
      const list = await (await this.service()).listSchedules();
      if (options.json) return this.json(list);
      const rows = list.map((s) => [
        s.name,
        `${s.spec.kind} ${s.spec.expression}${s.spec.timezone !== 'UTC' ? ` (${s.spec.timezone})` : ''}`,
        when(s.nextRunAt),
        s.paused ? (s.hardPaused ? 'hard' : s.pausedReason ?? 'yes') : '-',
        s.health,
        s.lastRun?.status ?? '-',
        s.lastRun ? `${s.lastRun.progress}%` : '-',
      ]);
      table(['NAME', 'SPEC', 'NEXT RUN', 'PAUSED', 'HEALTH', 'LAST', 'PROGRESS'], rows).forEach((l) => this.print(l));
    });
  }
}
