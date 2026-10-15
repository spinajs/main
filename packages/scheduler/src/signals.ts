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
  /** The finalizer's health decision; `ScheduleRunFailed` follows it. */
  countsAsFailure: boolean;
}

const iso = (ms: number | null | undefined): string | null => (ms ? new Date(ms).toISOString() : null);

/** An emit-mode run has one scheduler attempt; the queue's own attempt count is in the error data. */
function attemptsOf(run: RunModel, error: StructuredError | null): number {
  const queueAttempt = (error?.data as { attempt?: unknown } | undefined)?.attempt;
  return run.JobId && typeof queueAttempt === 'number' ? queueAttempt : run.Attempt;
}

/**
 * Run lifecycle notifications: log lines, `@spinajs/queue` events and metrics.
 * Events are sent without waiting: a broker client may hold an emit while it is disconnected (the
 * STOMP transport buffers until it reconnects), and a run must neither lose its lease nor stay
 * active because of that.
 */
@Singleton()
@Injectable()
export class SchedulerSignals {
  @Logger('SCHEDULER')
  protected Log: Log;

  protected pending = new Set<Promise<void>>();

  public runStarted(run: RunModel, now: number): Promise<void> {
    this.Log.info(`run ${run.Id} of ${run.Schedule} started (attempt ${run.Attempt}, trigger ${run.Trigger})`);
    // a retry starts after its backoff by design, which is not lag
    const scheduledAt = run.ScheduledAt;
    if (run.Attempt === 1 && scheduledAt) {
      this.measure((m) =>
        schedulerGauge(m, 'lag_seconds').set({ name: run.Schedule }, Math.max(0, (now - scheduledAt) / 1000)),
      );
    }
    this.send(() =>
      ScheduleRunStarted.emit({
        Schedule: run.Schedule,
        RunId: run.Id,
        Trigger: run.Trigger,
        Attempt: run.Attempt,
        ScheduledAt: iso(run.ScheduledAt),
      }),
    );
    return Promise.resolve();
  }

  public runFinished(run: RunModel, info: FinishedRunInfo): Promise<void> {
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
      this.send(() =>
        ScheduleRunSucceeded.emit({
          Schedule: run.Schedule,
          RunId: run.Id,
          Attempt: run.Attempt,
          DurationMs: info.durationMs,
        }),
      );
    } else if (info.countsAsFailure) {
      this.send(() =>
        ScheduleRunFailed.emit({
          Schedule: run.Schedule,
          RunId: run.Id,
          Attempt: run.Attempt,
          Status: info.status,
          Error: info.error,
        }),
      );
      if (info.status === 'dead') {
        this.send(() =>
          ScheduleDead.emit({
            Schedule: run.Schedule,
            RunId: run.Id,
            Attempts: attemptsOf(run, info.error),
            Error: info.error,
          }),
        );
      }
    }
    return Promise.resolve();
  }

  public retrying(run: RunModel, nextAttemptAt: number, error: StructuredError | null): Promise<void> {
    this.Log.warn(
      `run ${run.Id} of ${run.Schedule} attempt ${run.Attempt} failed${
        error ? ` (${error.message})` : ''
      }; retrying at ${new Date(nextAttemptAt).toISOString()}`,
    );
    this.measure((m) => schedulerCounter(m, 'retries_total').inc({ name: run.Schedule }));
    this.send(() =>
      ScheduleRetrying.emit({
        Schedule: run.Schedule,
        RunId: run.Id,
        Attempt: run.Attempt,
        NextAttemptAt: new Date(nextAttemptAt).toISOString(),
        Error: error,
      }),
    );
    return Promise.resolve();
  }

  public stepFinished(run: RunModel, step: string, status: StepStatus, durationMs: number): Promise<void> {
    this.Log.trace(`run ${run.Id} step '${step}' ${status} in ${durationMs} ms`);
    this.measure((m) =>
      schedulerHistogram(m, 'step_duration_seconds').observe({ name: run.Schedule, step }, durationMs / 1000),
    );
    return Promise.resolve();
  }

  public errorRegressed(run: RunModel, fingerprint: string, error: StructuredError): Promise<void> {
    this.Log.warn(`error group ${fingerprint} of ${run.Schedule} regressed in run ${run.Id}: ${error.message}`);
    this.send(() =>
      ScheduleErrorRegressed.emit({ Schedule: run.Schedule, RunId: run.Id, Fingerprint: fingerprint, Error: error }),
    );
    return Promise.resolve();
  }

  public healthChanged(schedule: string, consecutiveFailures: number): Promise<void> {
    this.Log.trace(`schedule ${schedule}: ${consecutiveFailures} consecutive failure(s)`);
    this.measure((m) => schedulerGauge(m, 'consecutive_failures').set({ name: schedule }, consecutiveFailures));
    return Promise.resolve();
  }

  public pausedByFailures(schedule: string, consecutiveFailures: number): Promise<void> {
    this.Log.warn(`schedule ${schedule} paused after ${consecutiveFailures} consecutive failures`);
    this.send(() => SchedulePausedByFailures.emit({ Schedule: schedule, ConsecutiveFailures: consecutiveFailures }));
    return Promise.resolve();
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

  /** Waits for the sends in flight, at most `timeoutMs` (real time); a hanging broker is left behind. */
  public async drain(timeoutMs = Infinity): Promise<void> {
    if (!this.pending.size) return;
    const all = Promise.all([...this.pending]).then(() => undefined);
    if (timeoutMs === Infinity) return all;
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref();
    });
    await Promise.race([all, limit]);
    clearTimeout(timer);
  }

  /** Best effort and never awaited by the run: a broker outage must not change a run's outcome. */
  protected send(emit: () => Promise<unknown>): void {
    const sending: Promise<void> = Promise.resolve()
      .then(emit)
      .then(
        () => undefined,
        (err) => this.Log.warn(err as Error, 'scheduler event not sent'),
      )
      .finally(() => this.pending.delete(sending));
    this.pending.add(sending);
  }
}
