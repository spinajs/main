import { v5 as uuidv5 } from 'uuid';
import { Autoinject, Injectable, Singleton } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import type { IWhereBuilder } from '@spinajs/orm';
import { JobModel, JobStatus } from '@spinajs/queue';
import type { RunStatus } from '../contract.js';
import { QueueJobFailedError } from '../errors.js';
import { defined, jsonColumn } from '../models/converters.js';
import { RunAttemptModel } from '../models/RunAttemptModel.js';
import { RunModel } from '../models/RunModel.js';
import { ScheduleRegistry } from '../registry/ScheduleRegistry.js';
import { RunEventWriter } from '../run/RunEventWriter.js';
import { RunFinalizer } from '../run/RunFinalizer.js';
import { safeJson, toStructuredError } from '../tracking/structured.js';

export const SCHEDULER_JOB_NAMESPACE = '5f0c5c2e-8f52-4a39-9d55-0b6f2c6f9a41';

/** Fields set on the emitted job next to `JobId`. */
export interface ScheduledJobPayload {
  SchedulerRunId: string;
  Schedule: string;
  ScheduledAt: string;
  Params: Record<string, unknown>;
}

export function emitJobKey(schedule: string, scheduledAt: number): string {
  return `${schedule}:${new Date(scheduledAt).toISOString()}`;
}

// queue_jobs.JobId is VARCHAR(36); the readable key does not fit, a name-based UUID does.
export function emitJobId(schedule: string, scheduledAt: number): string {
  return uuidv5(emitJobKey(schedule, scheduledAt), SCHEDULER_JOB_NAMESPACE);
}

/**
 * Readable job key of a run. Manual runs and retries store `ScheduledAt = now`, which several of them
 * share (all retries of one retry-failed call), and the queue skips a job id that already finished,
 * so they are keyed on the run instead of the occurrence.
 */
export function runJobKey(run: Pick<RunModel, 'Id' | 'Schedule' | 'Trigger' | 'ScheduledAt'>): string {
  if ((run.Trigger === 'schedule' || run.Trigger === 'catch-up') && run.ScheduledAt !== null) {
    return emitJobKey(run.Schedule, run.ScheduledAt);
  }
  return `${run.Schedule}:run:${run.Id}`;
}

export function runJobId(run: Pick<RunModel, 'Id' | 'Schedule' | 'Trigger' | 'ScheduledAt'>): string {
  return uuidv5(runJobKey(run), SCHEDULER_JOB_NAMESPACE);
}

export function mirrorStatus(s: JobStatus): RunStatus | null {
  switch (s) {
    case 'success':
      return 'succeeded';
    case 'error':
      return 'failed';
    case 'dead':
      return 'dead';
    default:
      return null;
  }
}

/**
 * Mirrors the `queue_jobs` row of every `emitted` run onto the run (R7: the queue has no status hook).
 * Every write is conditional on the run still being `emitted`, so replicas polling at the same time
 * finalize a run once.
 */
@Singleton()
@Injectable()
export class EmitMirror {
  @Logger('SCHEDULER')
  protected Log: Log;

  @Autoinject(RunEventWriter)
  protected Events: RunEventWriter;

  @Autoinject(RunFinalizer)
  protected Finalizer: RunFinalizer;

  @Autoinject(ScheduleRegistry)
  protected Registry: ScheduleRegistry;

  protected batchSize = 100;
  protected warned = false;
  /** Keyset position of the last full batch, so runs whose job never shows up cannot starve newer ones. */
  protected cursor: { createdAt: number; id: string } | null = null;

  /** Returns the number of runs this call finalized. */
  public async sync(now: number): Promise<number> {
    const runs = await this.nextBatch();
    if (!runs.length) return 0;

    let jobs: JobModel[];
    try {
      jobs = await JobModel.query().whereIn(
        'JobId',
        runs.map((r) => r.JobId),
      );
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        this.Log.warn(`emit mirroring is off: cannot read queue_jobs (${(err as Error).message})`);
      }
      return 0;
    }

    const byJobId = new Map(jobs.map((j) => [j.JobId, j]));
    let finalized = 0;
    for (const run of runs) {
      const job = byJobId.get(run.JobId as string);
      if (!job) continue;
      const status = mirrorStatus(job.Status);
      if (status) {
        if (await this.finish(run, job, status, now)) finalized++;
      } else {
        await this.mirrorProgress(run, job, now);
      }
    }
    return finalized;
  }

  protected async nextBatch(): Promise<RunModel[]> {
    const after = this.cursor;
    const emitted = RunModel.where('Status', 'emitted').whereNotNull('JobId');
    const query = after
      ? emitted.where(function (this: IWhereBuilder<unknown>) {
          this.where('CreatedAt', '>', after.createdAt).orWhere(function (this: IWhereBuilder<unknown>) {
            this.where('CreatedAt', after.createdAt).where('Id', '>', after.id);
          });
        })
      : emitted;
    const runs = await query.orderBy('CreatedAt').orderBy('Id').take(this.batchSize);
    const last = runs[runs.length - 1];
    this.cursor = runs.length < this.batchSize ? null : { createdAt: last.CreatedAt, id: last.Id };
    return runs;
  }

  protected async mirrorProgress(run: RunModel, job: JobModel, now: number): Promise<void> {
    const message =
      job.Status === 'retrying'
        ? `queue job retrying (attempt ${job.Attempt ?? 0}/${job.MaxAttempts ?? '?'})`
        : job.Message ?? run.Message;
    // 100 is reserved for the mirrored success
    const progress = Math.max(0, Math.min(99, Number(job.Progress ?? 0)));
    if (progress === run.Progress && message === run.Message) return;
    await RunModel.update({ Progress: progress, Message: message ?? null, UpdatedAt: now })
      .where('Id', run.Id)
      .where('Status', 'emitted');
  }

  protected async finish(run: RunModel, job: JobModel, status: RunStatus, now: number): Promise<boolean> {
    const error =
      status === 'succeeded'
        ? null
        : toStructuredError(
            new QueueJobFailedError(job.LastError ?? `queue job ${job.Status}`, {
              jobId: job.JobId,
              attempt: job.Attempt,
              maxAttempts: job.MaxAttempts,
            }),
            { attempt: run.Attempt, occurredAt: now },
          );
    const progress = status === 'succeeded' ? 100 : run.Progress;
    const r = await RunModel.update(
      defined({
        Status: status,
        Reason: 'queue',
        FinishedAt: now,
        UpdatedAt: now,
        Progress: progress,
        Result: status === 'succeeded' ? safeJson(job.Result) ?? undefined : undefined,
        Error: jsonColumn(error) as never,
      }),
    )
      .where('Id', run.Id)
      .where('Status', 'emitted');
    if (r.RowsAffected !== 1) return false;

    // the finalizer decides error grouping and health from Reason
    Object.assign(run, { Status: status, Reason: 'queue', FinishedAt: now, Progress: progress, Error: error });
    await RunAttemptModel.update({ FinishedAt: now, Status: status, Error: jsonColumn(error) as never })
      .where('RunId', run.Id)
      .where('Attempt', run.Attempt);
    if (error) await this.Events.write(run, run.Attempt, { type: 'error', error });
    await this.Events.write(run, run.Attempt, { type: 'status', status, reason: 'queue' });
    await this.Finalizer.finalized({
      run,
      def: this.Registry.find(run.Schedule),
      status,
      error,
      now,
      countsAsFailure: status !== 'succeeded',
    });
    return true;
  }
}
