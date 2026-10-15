import { Injectable, Singleton } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import type { RunStatus, StepStatus, StructuredError } from './contract.js';
import type { RunModel } from './models/RunModel.js';

export interface FinishedRunInfo {
  status: RunStatus;
  durationMs: number | null;
  error: StructuredError | null;
}

/** Run lifecycle notifications; queue events and metrics hook in here (Tasks 43-44). */
@Singleton()
@Injectable()
export class SchedulerSignals {
  @Logger('SCHEDULER')
  protected Log: Log;

  public runStarted(run: RunModel, _now: number): Promise<void> {
    this.Log.info(`run ${run.Id} of ${run.Schedule} started (attempt ${run.Attempt}, trigger ${run.Trigger})`);
    return Promise.resolve();
  }

  public runFinished(run: RunModel, info: FinishedRunInfo): Promise<void> {
    const text = `run ${run.Id} of ${run.Schedule} ended ${info.status}${
      info.durationMs !== null ? ` after ${info.durationMs} ms` : ''
    }`;
    if (info.error) this.Log.warn(`${text}: ${info.error.name}: ${info.error.message}`);
    else this.Log.info(text);
    return Promise.resolve();
  }

  public retrying(run: RunModel, nextAttemptAt: number, error: StructuredError | null): Promise<void> {
    this.Log.warn(
      `run ${run.Id} of ${run.Schedule} attempt ${run.Attempt} failed${
        error ? ` (${error.message})` : ''
      }; retrying at ${new Date(nextAttemptAt).toISOString()}`,
    );
    return Promise.resolve();
  }

  public stepFinished(run: RunModel, step: string, status: StepStatus, durationMs: number): Promise<void> {
    this.Log.trace(`run ${run.Id} step '${step}' ${status} in ${durationMs} ms`);
    return Promise.resolve();
  }
}
