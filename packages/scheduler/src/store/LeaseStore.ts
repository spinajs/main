import { Injectable, NewInstance } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import type { IWhereBuilder } from '@spinajs/orm';
import { InvalidArgument } from '@spinajs/exceptions';
import { isTerminalStatus, type RunStatus } from '../contract.js';
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

type ScheduleLeaseTake = 'free' | 'own' | false;

const leaseFree = (now: number) =>
  function (this: IWhereBuilder<unknown>) {
    this.whereNull('LeaseOwner').orWhere('LeaseUntil', '<', now);
  };

/**
 * Every write is a single conditional UPDATE whose WHERE is the ownership rule; the affected-row
 * count says whether this replica won. That count must mean "rows matched": SQLite `changes` and
 * Postgres `rowCount` do; MySQL `affectedRows` does only with CLIENT_FOUND_ROWS, which mysql2 sets
 * by default. Never connect the scheduler with `-FOUND_ROWS`: an update that writes identical
 * values (a heartbeat in the same millisecond) would then read as a lost lease.
 *
 * Run writes are fenced by `Attempt` as well as `LeaseOwner`: the owner is a replica, so an old
 * executor of a run that its own replica re-claimed would otherwise still match. A run becomes
 * claimable again only as `retrying`, and that claim increments the attempt.
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
    return (await this.takeScheduleLease(name, now)) !== false;
  }

  /**
   * Same rule as `leaseFree`, split in two statements to tell whether the expired lease was this
   * replica's own: a run of this replica may still be relying on it, so a failed claim must not release it.
   */
  protected async takeScheduleLease(name: string, now: number): Promise<ScheduleLeaseTake> {
    const values = { LeaseOwner: this.ReplicaId, LeaseUntil: now + this.LeaseTtl, UpdatedAt: now };
    const me = this.ReplicaId;
    const fromOthers = await ScheduleModel.update(values)
      .where('Name', name)
      .where(function (this: IWhereBuilder<unknown>) {
        this.whereNull('LeaseOwner').orWhere(function (this: IWhereBuilder<unknown>) {
          this.where('LeaseUntil', '<', now).where('LeaseOwner', '<>', me);
        });
      });
    if (fromOthers.RowsAffected === 1) return 'free';

    const own = await ScheduleModel.update(values)
      .where('Name', name)
      .where('LeaseOwner', me)
      .where('LeaseUntil', '<', now);
    return own.RowsAffected === 1 ? 'own' : false;
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
    if (run.Status !== 'queued' && run.Status !== 'retrying') return false;

    const lease = run.Forced ? null : await this.takeScheduleLease(run.Schedule, now);
    if (lease === false) return false;

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
      if (lease === 'free') await this.releaseScheduleLease(run.Schedule, now);
      return false;
    }

    Object.assign(run, claimed);
    return true;
  }

  /** Heartbeat of a running run (and its schedule lease); `ok: false` means this replica lost the run. */
  public async renewRun(
    runId: string,
    attempt: number,
    scheduleLease: string | null,
    now: number,
    patch: RunProgressPatch = {},
  ): Promise<{ ok: boolean; cancelRequested: boolean }> {
    const r = await RunModel.update({ ...defined(patch), LeaseUntil: now + this.LeaseTtl, UpdatedAt: now })
      .where('Id', runId)
      .where('LeaseOwner', this.ReplicaId)
      .where('Attempt', attempt)
      .where('Status', 'running');
    if (r.RowsAffected !== 1) return { ok: false, cancelRequested: false };
    if (scheduleLease && !(await this.renewScheduleLease(scheduleLease, now)))
      return { ok: false, cancelRequested: false };
    const row = await RunModel.where('Id', runId).first();
    return { ok: true, cancelRequested: !!row?.CancelRequested };
  }

  /** `patch` holds static-update values: JSON columns already serialized with `jsonColumn()`. */
  public async finishRun(runId: string, attempt: number, patch: Record<string, unknown>): Promise<boolean> {
    const r = await RunModel.update(patch as never)
      .where('Id', runId)
      .where('LeaseOwner', this.ReplicaId)
      .where('Attempt', attempt);
    return r.RowsAffected === 1;
  }

  /**
   * Takes over another replica's `running` run whose lease ran out. Conditional on the observed
   * `LeaseUntil`, so a heartbeat that landed after `run` was read wins over the expiry.
   */
  public async expireRun(run: RunModel, now: number, next: RunExpiry): Promise<boolean> {
    // A run that could be claimed again without a new attempt would defeat the attempt fence.
    if (next.status !== 'retrying' && !isTerminalStatus(next.status)) {
      throw new InvalidArgument(`scheduler: a run cannot expire to '${next.status}'`);
    }
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
