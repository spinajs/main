import { Injectable, Singleton } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import type { MetricMap } from '@spinajs/telemetry-common';
import type { RunStatus, StepStatus, StructuredError } from './contract.js';
import { ScheduleDead } from './events/ScheduleDead.js';
import { ScheduleErrorRegressed } from './events/ScheduleErrorRegressed.js';
import { SchedulePausedByFailures } from './events/SchedulePausedByFailures.js';
import { ScheduleRetrying } from './events/ScheduleRetrying.js';
import { ScheduleRunFailed } from './events/ScheduleRunFailed.js';
import { ScheduleRunStarted } from './events/ScheduleRunStarted.js';
import { ScheduleRunSucceeded } from './events/ScheduleRunSucceeded.js';
import { schedulerCounter, schedulerGauge, schedulerHistogram, schedulerMetrics } from './metrics.js';
import type { RunModel } from './models/RunModel.js';

export interface FinishedRunInfo {
  status: RunStatus;
  durationMs: number | null;
  error: StructuredError | null;
}

const iso = (ms: number | null | undefined): string | null => (ms ? new Date(ms).toISOString() : null);

/**
 * The same rule as health (design §9): shutdowns, lease loss and cancels are routine, so only a
 * timeout among the aborts is a failure.
 */
function isFailure(run: RunModel, status: RunStatus): boolean {
  return status === 'failed' || status === 'dead' || (status === 'aborted' && run.Reason === 'timeout');
}

/** An emit-mode run has one scheduler attempt; the queue's own attempt count is in the error data. */
function attemptsOf(run: RunModel, error: StructuredError | null): number {
  const queueAttempt = (error?.data as { attempt?: unknown } | undefined)?.attempt;
  return run.JobId && typeof queueAttempt === 'number' ? queueAttempt : run.Attempt;
}

/** Run lifecycle notifications: log lines, `@spinajs/queue` events and metrics. */
@Singleton()
@Injectable()
export class SchedulerSignals {
  @Logger('SCHEDULER')
  protected Log: Log;

  public async runStarted(run: RunModel, now: number): Promise<void> {
    this.Log.info(`run ${run.Id} of ${run.Schedule} started (attempt ${run.Attempt}, trigger ${run.Trigger})`);
    // a retry starts after its backoff by design, which is not lag
    const scheduledAt = run.ScheduledAt;
    if (run.Attempt === 1 && scheduledAt) {
      this.measure((m) =>
        schedulerGauge(m, 'lag_seconds').set({ name: run.Schedule }, Math.max(0, (now - scheduledAt) / 1000)),
      );
    }
    await this.send(() =>
      ScheduleRunStarted.emit({
        Schedule: run.Schedule,
        RunId: run.Id,
        Trigger: run.Trigger,
        Attempt: run.Attempt,
        ScheduledAt: iso(run.ScheduledAt),
      }),
    );
  }

  public async runFinished(run: RunModel, info: FinishedRunInfo): Promise<void> {
    const text = `run ${run.Id} of ${run.Schedule} ended ${info.status}${
      info.durationMs !== null ? ` after ${info.durationMs} ms` : ''
    }`;
    if (info.error) this.Log.warn(`${text}: ${info.error.name}: ${info.error.message}`);
    else this.Log.info(text);
    this.measure((m) => {
      schedulerCounter(m, 'runs_total').inc({ name: run.Schedule, status: info.status, trigger: run.Trigger });
      if (info.durationMs !== null) {
        schedulerHistogram(m, 'run_duration_seconds').observe({ name: run.Schedule }, info.durationMs / 1000);
      }
    });

    if (info.status === 'succeeded') {
      await this.send(() =>
        ScheduleRunSucceeded.emit({
          Schedule: run.Schedule,
          RunId: run.Id,
          Attempt: run.Attempt,
          DurationMs: info.durationMs,
        }),
      );
    } else if (isFailure(run, info.status)) {
      await this.send(() =>
        ScheduleRunFailed.emit({
          Schedule: run.Schedule,
          RunId: run.Id,
          Attempt: run.Attempt,
          Status: info.status,
          Error: info.error,
        }),
      );
      if (info.status === 'dead') {
        await this.send(() =>
          ScheduleDead.emit({
            Schedule: run.Schedule,
            RunId: run.Id,
            Attempts: attemptsOf(run, info.error),
            Error: info.error,
          }),
        );
      }
    }
  }

  public async retrying(run: RunModel, nextAttemptAt: number, error: StructuredError | null): Promise<void> {
    this.Log.warn(
      `run ${run.Id} of ${run.Schedule} attempt ${run.Attempt} failed${
        error ? ` (${error.message})` : ''
      }; retrying at ${new Date(nextAttemptAt).toISOString()}`,
    );
    this.measure((m) => schedulerCounter(m, 'retries_total').inc({ name: run.Schedule }));
    await this.send(() =>
      ScheduleRetrying.emit({
        Schedule: run.Schedule,
        RunId: run.Id,
        Attempt: run.Attempt,
        NextAttemptAt: new Date(nextAttemptAt).toISOString(),
        Error: error,
      }),
    );
  }

  public stepFinished(run: RunModel, step: string, status: StepStatus, durationMs: number): Promise<void> {
    this.Log.trace(`run ${run.Id} step '${step}' ${status} in ${durationMs} ms`);
    this.measure((m) =>
      schedulerHistogram(m, 'step_duration_seconds').observe({ name: run.Schedule, step }, durationMs / 1000),
    );
    return Promise.resolve();
  }

  public async errorRegressed(run: RunModel, fingerprint: string, error: StructuredError): Promise<void> {
    this.Log.warn(`error group ${fingerprint} of ${run.Schedule} regressed in run ${run.Id}: ${error.message}`);
    await this.send(() =>
      ScheduleErrorRegressed.emit({ Schedule: run.Schedule, RunId: run.Id, Fingerprint: fingerprint, Error: error }),
    );
  }

  public healthChanged(schedule: string, consecutiveFailures: number): Promise<void> {
    this.Log.trace(`schedule ${schedule}: ${consecutiveFailures} consecutive failure(s)`);
    this.measure((m) => schedulerGauge(m, 'consecutive_failures').set({ name: schedule }, consecutiveFailures));
    return Promise.resolve();
  }

  public async pausedByFailures(schedule: string, consecutiveFailures: number): Promise<void> {
    this.Log.warn(`schedule ${schedule} paused after ${consecutiveFailures} consecutive failures`);
    await this.send(() =>
      SchedulePausedByFailures.emit({ Schedule: schedule, ConsecutiveFailures: consecutiveFailures }),
    );
  }

  protected measure(record: (m: MetricMap) => void): void {
    const m = schedulerMetrics();
    if (!m) return;
    try {
      record(m);
    } catch (err) {
      this.Log.warn(err as Error, 'scheduler metric not recorded');
    }
  }

  /** Best effort: a broker outage must not change a run's outcome. */
  protected async send(emit: () => Promise<unknown>): Promise<void> {
    try {
      await emit();
    } catch (err) {
      this.Log.warn(err as Error, 'scheduler event not sent');
    }
  }
}
