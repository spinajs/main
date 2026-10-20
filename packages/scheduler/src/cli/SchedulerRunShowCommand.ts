import { Argument, Command, Option } from '@spinajs/cli';
import { isTerminalEvent } from '../contract.js';
import { follow } from '../cli-support/follow.js';
import { duration, formatEvent, table, when } from '../cli-support/format.js';
import { SchedulerCommand } from '../cli-support/SchedulerCommand.js';

@Command('scheduler:run:show', 'Shows a run: status, attempts, steps, result, error and log lines')
@Argument('id', true, 'run id')
@Option('--follow', false, 'stream steps and progress until the run ends')
@Option('--json', false, 'print JSON')
export class SchedulerRunShowCommand extends SchedulerCommand {
  public async execute(id: string, options: { follow?: boolean; json?: boolean }): Promise<void> {
    this.jsonLines = !!(options.json && options.follow);
    await this.guard(!!options.json, async () => {
      const service = await this.service();
      const r = await service.getRun(id);
      if (options.json && !options.follow) return this.json(r);
      if (!options.json) {
        const by = r.triggeredBy ? ` by ${r.triggeredBy.kind}:${r.triggeredBy.id}` : '';
        const next = r.nextAttemptAt ? `, next ${when(r.nextAttemptAt)}` : '';
        this.print(`run:      ${r.id} (${r.schedule})`);
        this.print(`status:   ${r.status}${r.reason ? ` (${r.reason})` : ''}${r.stale ? ' [stale]' : ''}`);
        this.print(`trigger:  ${r.trigger}${by}${r.parentRunId ? `, retry of ${r.parentRunId}` : ''}`);
        this.print(`attempt:  ${r.attempt}/${r.maxAttempts}${next}`);
        this.print(
          `progress: ${r.progress}%${r.currentStep ? ` in ${r.currentStep}` : ''}${r.message ? ` - ${r.message}` : ''}`,
        );
        this.print(
          `timing:   created ${when(r.createdAt)}, started ${when(r.startedAt)}, finished ${when(
            r.finishedAt,
          )}, took ${duration(r.durationMs)}`,
        );
        if (r.error) {
          this.print(`error:    ${r.error.name}: ${r.error.message}${r.error.step ? ` (step ${r.error.step})` : ''}`);
        }
        if (r.result !== null && r.result !== undefined) this.print(`result:   ${JSON.stringify(r.result)}`);
        if (r.steps.length) {
          this.print();
          table(
            ['ATTEMPT', 'STEP', 'STATUS', 'DURATION', 'PROGRESS', 'MESSAGE'],
            r.steps.map((s) => [
              String(s.attempt),
              s.name,
              s.status,
              duration(s.durationMs),
              `${s.progress}%`,
              s.message ?? '',
            ]),
          ).forEach((l) => this.print(l));
        }
        if (r.logs.length) {
          this.print();
          r.logs.forEach((e) => this.print(formatEvent(e)));
        }
      }
      if (options.follow) await this.followRun(id, !!options.json);
    });
  }

  protected async followRun(id: string, asJson: boolean): Promise<void> {
    if (!asJson) this.print('--- following ---');
    await follow(await this.service(), this.config(), {
      target: { runId: id },
      onEvent: (e) => this.print(asJson ? JSON.stringify(e) : formatEvent(e)),
      until: isTerminalEvent,
    });
  }
}
