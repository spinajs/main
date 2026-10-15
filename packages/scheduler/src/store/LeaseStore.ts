import { Injectable, NewInstance } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import type { IWhereBuilder } from '@spinajs/orm';
import type { RunStatus } from '../contract.js';
import { ScheduleModel } from '../models/ScheduleModel.js';
import { RunModel } from '../models/RunModel.js';
import { defined } from '../models/converters.js';
import { defaultReplicaId } from './replica.js';

export interface OccurrenceInput {
  name: string;
  expectedNextRunAt: number;
  nextRunAt: number | null;
  /** Database time (DbClock), never the replica clock. */
  now: number;
}

export interface RunProgressPatch {
  Progress?: number;
  CurrentStep?: string | null;
  Message?: string | null;
}

export interface RunExpiry {
  status: RunStatus;
  reason: string;
  nextAttemptAt: number | null;
}

const leaseFree = (now: number) =>
  function (this: IWhereBuilder<unknown>) {
    this.whereNull('LeaseOwner').orWhere('LeaseUntil', '<', now);
  };

/**
 * Every write is a single conditional UPDATE whose WHERE is the ownership rule; the affected-row
 * count says whether this replica won. That count means "rows matched" on every driver: SQLite
 * `changes`, Postgres `rowCount`, and MySQL `affectedRows` because mysql2 always connects with
 * CLIENT_FOUND_ROWS, so an update that writes identical values still counts as a win.
 */
@NewInstance()
@Injectable()
export class LeaseStore {
  @Config('scheduler.leaseTtl', { defaultValue: 60_000 })
  public LeaseTtl: number;

  constructor(public readonly ReplicaId: string = defaultReplicaId()) {}

  /** Takes the schedule lease and advances NextRunAt in one statement, so a won occurrence is never fired twice. */
  public async tryClaimOccurrence(o: OccurrenceInput): Promise<boolean> {
    const r = await ScheduleModel.update({
      LeaseOwner: this.ReplicaId,
      LeaseUntil: o.now + this.LeaseTtl,
      LastFiredAt: o.now,
      NextRunAt: o.nextRunAt,
      UpdatedAt: o.now,
    })
      .where('Name', o.name)
      .where('Paused', false)
      .where('NextRunAt', o.expectedNextRunAt)
      .where(leaseFree(o.now));
    return r.RowsAffected === 1;
  }

  /** Moves past an occurrence without the lease; the replica that wins decides skip / queue / misfire for it. */
  public async advanceOccurrence(o: OccurrenceInput): Promise<boolean> {
    const r = await ScheduleModel.update({ NextRunAt: o.nextRunAt, UpdatedAt: o.now })
      .where('Name', o.name)
      .where('Paused', false)
      .where('NextRunAt', o.expectedNextRunAt);
    return r.RowsAffected === 1;
  }

  public async acquireScheduleLease(name: string, now: number): Promise<boolean> {
    const r = await ScheduleModel.update({
      LeaseOwner: this.ReplicaId,
      LeaseUntil: now + this.LeaseTtl,
      UpdatedAt: now,
    })
      .where('Name', name)
      .where(leaseFree(now));
    return r.RowsAffected === 1;
  }

  public async renewScheduleLease(name: string, now: number): Promise<boolean> {
    const r = await ScheduleModel.update({ LeaseUntil: now + this.LeaseTtl })
      .where('Name', name)
      .where('LeaseOwner', this.ReplicaId);
    return r.RowsAffected === 1;
  }

  public async releaseScheduleLease(name: string, now: number): Promise<boolean> {
    const r = await ScheduleModel.update({ LeaseOwner: null, LeaseUntil: null, UpdatedAt: now })
      .where('Name', name)
      .where('LeaseOwner', this.ReplicaId);
    return r.RowsAffected === 1;
  }

  public async recordLast(name: string, now: number, status: RunStatus, runId: string): Promise<void> {
    await ScheduleModel.update({ LastFinishedAt: now, LastStatus: status, LastRunId: runId, UpdatedAt: now }).where(
      'Name',
      name,
    );
  }

  /**
   * Claims a `queued` or `retrying` run as observed in `run`, which is updated on success.
   * A non-forced run first takes the schedule lease, which is what keeps runs of one schedule from overlapping.
   */
  public async claimRun(run: RunModel, now: number): Promise<boolean> {
    if (!run.Forced && !(await this.acquireScheduleLease(run.Schedule, now))) return false;

    const claimed = {
      Status: 'running' as const,
      Attempt: run.Status === 'retrying' ? run.Attempt + 1 : run.Attempt,
      LeaseOwner: this.ReplicaId,
      LeaseUntil: now + this.LeaseTtl,
      StartedAt: run.StartedAt ?? now,
      UpdatedAt: now,
      NextAttemptAt: null,
      Reason: null,
    };
    const r = await RunModel.update(claimed)
      .where('Id', run.Id)
      .where('Status', run.Status)
      .where('Attempt', run.Attempt)
      .where(function (this: IWhereBuilder<unknown>) {
        this.whereNull('NextAttemptAt').orWhere('NextAttemptAt', '<=', now);
      });

    if (r.RowsAffected !== 1) {
      if (!run.Forced) await this.releaseScheduleLease(run.Schedule, now);
      return false;
    }

    Object.assign(run, claimed);
    return true;
  }

  /** Heartbeat of a running run (and its schedule lease); `ok: false` means this replica lost the run. */
  public async renewRun(
    runId: string,
    scheduleLease: string | null,
    now: number,
    patch: RunProgressPatch = {},
  ): Promise<{ ok: boolean; cancelRequested: boolean }> {
    const r = await RunModel.update({ ...defined(patch), LeaseUntil: now + this.LeaseTtl, UpdatedAt: now })
      .where('Id', runId)
      .where('LeaseOwner', this.ReplicaId)
      .where('Status', 'running');
    if (r.RowsAffected !== 1) return { ok: false, cancelRequested: false };
    if (scheduleLease && !(await this.renewScheduleLease(scheduleLease, now)))
      return { ok: false, cancelRequested: false };
    const row = await RunModel.where('Id', runId).first();
    return { ok: true, cancelRequested: !!row?.CancelRequested };
  }

  /** `patch` holds static-update values: JSON columns already serialized with `jsonColumn()`. */
  public async finishRun(runId: string, patch: Record<string, unknown>): Promise<boolean> {
    const r = await RunModel.update(patch as never)
      .where('Id', runId)
      .where('LeaseOwner', this.ReplicaId);
    return r.RowsAffected === 1;
  }

  /**
   * Takes over another replica's `running` run whose lease ran out. Conditional on the observed
   * `LeaseUntil`, so a heartbeat that landed after `run` was read wins over the expiry.
   */
  public async expireRun(run: RunModel, now: number, next: RunExpiry): Promise<boolean> {
    const final = next.status !== 'retrying';
    const r = await RunModel.update({
      Status: next.status,
      Reason: next.reason,
      LeaseOwner: null,
      LeaseUntil: null,
      NextAttemptAt: next.nextAttemptAt,
      FinishedAt: final ? now : null,
      UpdatedAt: now,
    })
      .where('Id', run.Id)
      .where('Status', 'running')
      .where('LeaseUntil', run.LeaseUntil)
      .where('LeaseUntil', '<', now);
    return r.RowsAffected === 1;
  }
}
