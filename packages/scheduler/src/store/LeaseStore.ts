import { Injectable, NewInstance } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import type { IWhereBuilder } from '@spinajs/orm';
import type { RunStatus } from '../contract.js';
import { ScheduleModel } from '../models/ScheduleModel.js';
import { defaultReplicaId } from './replica.js';

export interface OccurrenceInput {
  name: string;
  expectedNextRunAt: number;
  nextRunAt: number | null;
  /** Database time (DbClock), never the replica clock. */
  now: number;
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
    const r = await ScheduleModel.update({ LeaseOwner: this.ReplicaId, LeaseUntil: o.now + this.LeaseTtl, LastFiredAt: o.now, NextRunAt: o.nextRunAt, UpdatedAt: o.now })
      .where('Name', o.name)
      .where('Paused', false)
      .where('NextRunAt', o.expectedNextRunAt)
      .where(leaseFree(o.now));
    return r.RowsAffected === 1;
  }

  /** Moves past an occurrence without the lease; the replica that wins decides skip / queue / misfire for it. */
  public async advanceOccurrence(o: OccurrenceInput): Promise<boolean> {
    const r = await ScheduleModel.update({ NextRunAt: o.nextRunAt, UpdatedAt: o.now }).where('Name', o.name).where('Paused', false).where('NextRunAt', o.expectedNextRunAt);
    return r.RowsAffected === 1;
  }

  public async acquireScheduleLease(name: string, now: number): Promise<boolean> {
    const r = await ScheduleModel.update({ LeaseOwner: this.ReplicaId, LeaseUntil: now + this.LeaseTtl, UpdatedAt: now }).where('Name', name).where(leaseFree(now));
    return r.RowsAffected === 1;
  }

  public async renewScheduleLease(name: string, now: number): Promise<boolean> {
    const r = await ScheduleModel.update({ LeaseUntil: now + this.LeaseTtl }).where('Name', name).where('LeaseOwner', this.ReplicaId);
    return r.RowsAffected === 1;
  }

  public async releaseScheduleLease(name: string, now: number): Promise<boolean> {
    const r = await ScheduleModel.update({ LeaseOwner: null, LeaseUntil: null, UpdatedAt: now }).where('Name', name).where('LeaseOwner', this.ReplicaId);
    return r.RowsAffected === 1;
  }

  public async recordLast(name: string, now: number, status: RunStatus, runId: string): Promise<void> {
    await ScheduleModel.update({ LastFinishedAt: now, LastStatus: status, LastRunId: runId, UpdatedAt: now }).where('Name', name);
  }
}
