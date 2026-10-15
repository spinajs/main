import { Autoinject, DI, Injectable, Singleton } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import type { RunStatus, StructuredError } from '../contract.js';
import type { ScheduleDefinition } from '../interfaces.js';
import type { RunModel } from '../models/RunModel.js';
import { SchedulerSignals } from '../signals.js';
import { LeaseStore } from '../store/LeaseStore.js';
import { ErrorTracker } from '../tracking/ErrorTracker.js';

export interface FinalizeInput {
  run: RunModel;
  def?: ScheduleDefinition;
  status: RunStatus;
  error: StructuredError | null;
  now: number;
  countsAsFailure: boolean;
  nextAttemptAt?: number | null;
}

/** The single hook every place that ends a run calls (executor, reaper, service, emit mirror). */
@Singleton()
@Injectable()
export class RunFinalizer {
  @Logger('SCHEDULER')
  protected Log: Log;

  @Autoinject(SchedulerSignals)
  protected Signals: SchedulerSignals;

  @Autoinject(ErrorTracker)
  protected Errors: ErrorTracker;

  public async finalized(input: FinalizeInput): Promise<void> {
    const { run, status, now } = input;

    // every failed attempt counts in its error group, also one that will be retried
    const error = input.error;
    if (error) {
      await this.bestEffort(`record the error of run ${run.Id}`, async () => {
        const recorded = await this.Errors.record(run.Schedule, run.Id, error, now);
        if (recorded.regressed) await this.Signals.errorRegressed(run, recorded.fingerprint, error);
      });
    }

    if (status === 'retrying') {
      await this.Signals.retrying(run, input.nextAttemptAt ?? now, input.error);
      return;
    }

    // A skipped/misfired record must not replace the run that is actually in progress.
    if (status !== 'skipped' && status !== 'misfired') {
      await DI.resolve(LeaseStore).recordLast(run.Schedule, now, status, run.Id);
    }

    await this.Signals.runFinished(run, {
      status,
      durationMs: run.StartedAt ? now - run.StartedAt : null,
      error: input.error,
    });
  }

  /** The run row is final already: a failed tracking write must not skip the rest of the hook. */
  protected async bestEffort(what: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (err) {
      this.Log.warn(err as Error, `could not ${what}`);
    }
  }
}
