import { Command, Option } from '@spinajs/cli';
import { SchedulerCommand } from '../cli-support/SchedulerCommand.js';

@Command('scheduler:prune', 'Removes orphaned schedules and runs, logs and errors past retention')
@Option('--json', false, 'print JSON')
export class SchedulerPruneCommand extends SchedulerCommand {
  public async execute(options: { json?: boolean }): Promise<void> {
    await this.guard(!!options.json, async () => {
      const r = await (await this.service()).prune({ triggeredBy: this.principal() });
      return options.json
        ? this.json(r)
        : this.print(
            `removed ${r.orphanedSchedules} orphaned schedule(s), ${r.runs} run(s), ${r.logs} log row(s), ${r.errors} error group(s)`,
          );
    });
  }
}
