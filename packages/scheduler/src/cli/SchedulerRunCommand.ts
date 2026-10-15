import { Argument, Command, Option } from '@spinajs/cli';
import { DI } from '@spinajs/di';
import {
  isTerminalStatus,
  RunConflict,
  SCHEDULER_EXIT_OK,
  SCHEDULER_EXIT_RUN_FAILED,
  SchedulerService,
} from '../contract.js';
import { follow } from '../cli-support/follow.js';
import { formatEvent } from '../cli-support/format.js';
import { collect, parseParams } from '../cli-support/params.js';
import { SchedulerCommand } from '../cli-support/SchedulerCommand.js';
import { RunModel } from '../models/RunModel.js';
import { Scheduler } from '../Scheduler.js';
import { Clock, DbClock } from '../time/clock.js';

interface RunCommandOptions {
  params?: string;
  param?: string[];
  force?: boolean;
  wait?: boolean;
  follow?: boolean;
  local?: boolean;
  json?: boolean;
}

@Command('scheduler:run', 'Runs a schedule now (manual run)')
@Argument('name', true, 'schedule name')
@Option('--params <json>', false, 'parameters as a JSON object')
@Option({
  flags: '--param <key=value>',
  description: 'one parameter; repeat for more',
  parser: collect as never,
  defaultValue: [],
})
@Option('--force', false, 'queue or start even if a run is in progress')
@Option('--wait', false, 'wait for the run to end; exit 1 unless it succeeded')
@Option('--follow', false, 'stream steps and progress until the run ends')
@Option('--local', false, 'claim and execute the run in this process (implies --wait)')
@Option('--json', false, 'print JSON')
export class SchedulerRunCommand extends SchedulerCommand {
  public async execute(name: string, o: RunCommandOptions): Promise<void> {
    await this.guard(!!o.json, async () => {
      const service = await this.service();
      const params = parseParams(o.params, o.param ?? []);
      const { runId } = await service.runNow(name, { params, force: !!o.force, triggeredBy: this.principal() });

      if (o.local) {
        const scheduler = await this.localScheduler();
        if (!(await scheduler.runLocally(runId))) {
          throw new RunConflict(
            `run ${runId} is queued but could not be claimed in this process; another run holds the schedule lease`,
            runId,
          );
        }
      }

      if (!o.wait && !o.follow && !o.local) {
        if (o.json) this.json({ runId });
        else this.print(`queued run ${runId}`);
        return;
      }

      await this.waitForRun(service, runId, !!o.local, !!o.json, !!o.follow);
      const run = await service.getRun(runId);
      process.exitCode = run.status === 'succeeded' ? SCHEDULER_EXIT_OK : SCHEDULER_EXIT_RUN_FAILED;
      if (o.json) this.json({ runId, run });
      else this.print(`run ${runId} ${run.status}${run.error ? `: ${run.error.message}` : ''}`);
    });
  }

  /** The loop is never started here, so only the runs this command claims execute in the CLI process. */
  protected localScheduler(): Promise<Scheduler> {
    return DI.resolve(Scheduler, [{ autoStart: false }]);
  }

  protected async waitForRun(
    service: SchedulerService,
    runId: string,
    local: boolean,
    asJson: boolean,
    printEvents: boolean,
  ): Promise<void> {
    const stop = new AbortController();
    let failure: unknown;
    const retries = local
      ? this.runRetriesLocally(await this.localScheduler(), runId, stop.signal).catch((err) => {
          failure = err;
          stop.abort();
        })
      : undefined;

    // a local run is executed by this process, so its events are in-process even when an HTTP endpoint is configured
    const config = local ? { ...this.config(), cli: {} } : this.config();
    try {
      await follow(service, config, {
        target: { runId },
        signal: stop.signal,
        onEvent: (e) => {
          if (printEvents) this.print(asJson ? JSON.stringify(e) : formatEvent(e));
        },
        // a local process never mirrors queue jobs, so it stops at 'emitted'
        until: (e) => e.type === 'status' && (isTerminalStatus(e.status) || (local && e.status === 'emitted')),
      });
    } finally {
      stop.abort();
      await retries;
    }
    if (failure !== undefined) throw failure;
  }

  /**
   * With `autoStart: false` nothing in this process claims the next attempt of a `retrying` run, so a
   * `--local` wait drives it: sleep until `NextAttemptAt` (database time), then claim it here. A refused
   * claim means another replica took the run or holds the schedule; the run is watched until it ends.
   */
  protected async runRetriesLocally(scheduler: Scheduler, runId: string, signal: AbortSignal): Promise<void> {
    const db = DI.resolve(DbClock);
    const timers = DI.resolve(Clock);
    const tick = this.config().tick;
    while (!signal.aborted) {
      await scheduler.idle();
      const run = await RunModel.where('Id', runId).first();
      if (!run || isTerminalStatus(run.Status) || signal.aborted) return;
      if (run.Status !== 'retrying') {
        await timers.sleep(tick, signal);
        continue;
      }
      const wait = (run.NextAttemptAt ?? 0) - (await db.sync());
      if (wait <= 0 && (await scheduler.runLocally(runId))) continue;
      await timers.sleep(wait > 0 ? wait : tick, signal);
    }
  }
}
