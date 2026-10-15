import { Argument, Command, Option } from '@spinajs/cli';
import type { ErrorGroupStatus } from '../contract.js';
import { SchedulerCommand } from '../cli-support/SchedulerCommand.js';

@Command('scheduler:errors:resolve', 'Marks an error group resolved (or ignored / open)')
@Argument('fingerprint', true, 'error group fingerprint')
@Option('--status <status>', false, 'resolved (default), ignored or open', 'resolved')
@Option('--json', false, 'print JSON')
export class SchedulerErrorsResolveCommand extends SchedulerCommand {
  public async execute(fingerprint: string, options: { status?: ErrorGroupStatus; json?: boolean }): Promise<void> {
    await this.guard(!!options.json, async () => {
      const group = await (
        await this.service()
      ).setErrorStatus(fingerprint, options.status ?? 'resolved', { triggeredBy: this.principal() });
      return options.json ? this.json(group) : this.print(`error group ${fingerprint} is now ${group.status}`);
    });
  }
}
