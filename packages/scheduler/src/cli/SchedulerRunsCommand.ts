import { Argument, Command, Option } from '@spinajs/cli';
import { duration, table, when } from '../cli-support/format.js';
import { oneOf, parseLimit, RUN_STATUSES } from '../cli-support/params.js';
import { SchedulerCommand } from '../cli-support/SchedulerCommand.js';

@Command('scheduler:runs', 'Lists runs, newest first')
@Argument('name', false, 'schedule name')
@Option('--status <status>', false, 'only runs in this status')
@Option('--limit <n>', false, 'page size (max 500)')
@Option('--json', false, 'print JSON')
export class SchedulerRunsCommand extends SchedulerCommand {
  public async execute(
    name: string | undefined,
    options: { status?: string; limit?: string | number; json?: boolean },
  ): Promise<void> {
    await this.guard(!!options.json, async () => {
      const status = oneOf('status', options.status, RUN_STATUSES);
      const limit = parseLimit(options.limit);
      const page = await (await this.service()).listRuns({ schedule: name, status, limit });
      if (options.json) return this.json(page);
      const rows = page.items.map((r) => [
        r.id,
        r.status,
        r.trigger,
        `${r.attempt}/${r.maxAttempts}`,
        when(r.createdAt),
        duration(r.durationMs),
        `${r.progress}%`,
        r.message ?? '',
      ]);
      table(['ID', 'STATUS', 'TRIGGER', 'ATTEMPT', 'CREATED', 'DURATION', 'PROGRESS', 'MESSAGE'], rows).forEach((l) =>
        this.print(l),
      );
    });
  }
}
