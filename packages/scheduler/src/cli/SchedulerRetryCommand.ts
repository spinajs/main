import { Argument, Command, Option } from '@spinajs/cli';
import { InvalidRunParams } from '../contract.js';
import { collect, parseParams } from '../cli-support/params.js';
import { SchedulerCommand } from '../cli-support/SchedulerCommand.js';

interface RetryCommandOptions {
  fromStep?: string;
  /** Undefined unless `--resume` or `--no-resume` is given: the service then uses the schedule's `resumable`. */
  resume?: boolean;
  params?: string;
  param?: string[];
  schedule?: string;
  failedSince?: string;
  json?: boolean;
}

@Command('scheduler:retry', 'Retries a failed, dead or aborted run, or every failed run of a schedule since a time')
@Argument('id', false, 'run id')
@Option('--from-step <name>', false, 're-run from this step on (implies resume)')
@Option('--resume', false, 'skip completed steps and reuse the last checkpoint')
@Option('--no-resume', false, 'run every step again')
@Option('--params <json>', false, 'override the parameters')
@Option({
  flags: '--param <key=value>',
  description: 'override one parameter',
  parser: collect as never,
  defaultValue: [],
})
@Option('--schedule <name>', false, 'with --failed-since: retry all failed runs of this schedule')
@Option('--failed-since <time>', false, 'ISO time; with --schedule')
@Option('--json', false, 'print JSON')
export class SchedulerRetryCommand extends SchedulerCommand {
  public async execute(id: string | undefined, o: RetryCommandOptions): Promise<void> {
    await this.guard(!!o.json, async () => {
      const service = await this.service();
      if (id) {
        const params = parseParams(o.params, o.param ?? []);
        const result = await service.retry(id, {
          fromStep: o.fromStep,
          params,
          resume: o.resume,
          triggeredBy: this.principal(),
        });
        return o.json ? this.json(result) : this.print(`queued retry ${result.runId} of run ${id}`);
      }
      if (o.schedule && o.failedSince) {
        const result = await service.retryFailed(o.schedule, o.failedSince, { triggeredBy: this.principal() });
        const n = result.runIds.length;
        return o.json
          ? this.json(result)
          : this.print(`queued ${n} retr${n === 1 ? 'y' : 'ies'}: ${result.runIds.join(', ') || '-'}`);
      }
      throw new InvalidRunParams('give a run id, or --schedule together with --failed-since', [
        { path: '', message: 'missing run id' },
      ]);
    });
  }
}
