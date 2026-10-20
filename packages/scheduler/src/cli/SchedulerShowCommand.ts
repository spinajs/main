import { Argument, Command, Option } from '@spinajs/cli';
import { table, when } from '../cli-support/format.js';
import { SchedulerCommand } from '../cli-support/SchedulerCommand.js';

@Command('scheduler:show', 'Shows a schedule: definition, health, recent runs and open error groups')
@Argument('name', true, 'schedule name')
@Option('--json', false, 'print JSON')
export class SchedulerShowCommand extends SchedulerCommand {
  public async execute(name: string, options: { json?: boolean }): Promise<void> {
    await this.guard(!!options.json, async () => {
      const d = await (await this.service()).getSchedule(name);
      if (options.json) return this.json(d);
      this.print(`name:      ${d.name}${d.orphaned ? ' (orphaned)' : ''}`);
      this.print(`spec:      ${d.spec.kind} ${d.spec.expression} ${d.spec.timezone}`);
      this.print(`mode:      ${d.mode}, runOn ${d.runOn}${d.enabled ? '' : ', disabled'}`);
      this.print(`next run:  ${when(d.nextRunAt)}`);
      this.print(`paused:    ${d.paused ? `${d.pausedReason ?? 'manual'}${d.hardPaused ? ' (hard)' : ''}` : 'no'}`);
      this.print(
        `health:    ${d.health} (${d.consecutiveFailures} consecutive failures, last success ${when(d.lastSuccessAt)})`,
      );
      this.print();
      table(
        ['RUN', 'STATUS', 'TRIGGER', 'CREATED'],
        d.recentRuns.map((r) => [r.id, r.status, r.trigger, when(r.createdAt)]),
      ).forEach((l) => this.print(l));
      if (d.openErrors.length) {
        this.print();
        table(
          ['FINGERPRINT', 'COUNT', 'LAST SEEN', 'MESSAGE'],
          d.openErrors.map((e) => [e.fingerprint, String(e.count), when(e.lastSeen), e.sampleMessage.split('\n')[0]]),
        ).forEach((l) => this.print(l));
      }
    });
  }
}
