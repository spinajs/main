import { Autoinject, DI, Injectable, Singleton } from '@spinajs/di';
import type { RunStatus, StructuredError } from '../contract.js';
import type { ScheduleDefinition } from '../interfaces.js';
import type { RunModel } from '../models/RunModel.js';
import { SchedulerSignals } from '../signals.js';
import { LeaseStore } from '../store/LeaseStore.js';

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
  @Autoinject(SchedulerSignals)
  protected Signals: SchedulerSignals;

  public async finalized(input: FinalizeInput): Promise<void> {
    const { run, status, now } = input;

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
}
