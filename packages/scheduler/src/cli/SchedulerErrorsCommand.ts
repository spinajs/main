import { Argument, Command, Option } from '@spinajs/cli';
import { table, when } from '../cli-support/format.js';
import { oneOf } from '../cli-support/params.js';
import { ERROR_GROUP_STATUSES } from '../service/statuses.js';
import { SchedulerCommand } from '../cli-support/SchedulerCommand.js';

@Command('scheduler:errors', 'Lists grouped errors')
@Argument('name', false, 'schedule name')
@Option('--status <status>', false, 'open, resolved or ignored')
@Option('--json', false, 'print JSON')
export class SchedulerErrorsCommand extends SchedulerCommand {
  public async execute(name: string | undefined, options: { status?: string; json?: boolean }): Promise<void> {
    await this.guard(!!options.json, async () => {
      const status = oneOf('status', options.status, ERROR_GROUP_STATUSES);
      const groups = await (await this.service()).listErrors({ schedule: name, status });
      if (options.json) return this.json(groups);
      const rows = groups.map((g) => [
        g.fingerprint,
        g.schedule,
        g.name,
        String(g.count),
        when(g.lastSeen),
        g.status,
        g.sampleMessage.split('\n')[0],
      ]);
      table(['FINGERPRINT', 'SCHEDULE', 'NAME', 'COUNT', 'LAST SEEN', 'STATUS', 'MESSAGE'], rows).forEach((l) =>
        this.print(l),
      );
    });
  }
}
