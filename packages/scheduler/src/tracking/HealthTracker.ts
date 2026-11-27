import { Injectable, Singleton } from '@spinajs/di';
import type { ScheduleHealth } from '../contract.js';
import { ScheduleModel } from '../models/ScheduleModel.js';
import { scheduleRow, type ScheduleRef } from '../store/keys.js';

export function healthOf(row: {
  Paused: boolean;
  PausedReason: string | null;
  ConsecutiveFailures: number;
}): ScheduleHealth {
  if (row.Paused && row.PausedReason === 'failures') return 'paused-by-failures';
  return row.ConsecutiveFailures > 0 ? 'failing' : 'ok';
}

export interface FailureRecord {
  /** The count after this failure as read back; concurrent failures of other replicas may be included. */
  consecutive: number;
  /** This call paused the schedule; of several concurrent callers only one gets true. */
  paused: boolean;
}

/**
 * `ConsecutiveFailures` / `LastSuccessAt` on `__scheduler`. Several replicas finish runs
 * of one schedule at once, so the counter is incremented in place and the pause is a conditional update.
 */
@Singleton()
@Injectable()
export class HealthTracker {
  public async recordSuccess(schedule: ScheduleRef, now: number): Promise<void> {
    await ScheduleModel.update({ ConsecutiveFailures: 0, LastSuccessAt: now, UpdatedAt: now }).where(scheduleRow(schedule));
  }

  public async recordFailure(
    schedule: ScheduleRef,
    pauseAfterFailures: number | undefined,
    now: number,
  ): Promise<FailureRecord> {
    const counted = await ScheduleModel.update({ UpdatedAt: now }).increment('ConsecutiveFailures').where(scheduleRow(schedule));
    if (!counted.RowsAffected) return { consecutive: 0, paused: false };

    let paused = false;
    if (pauseAfterFailures) {
      // a manual pause is left alone: its reason must survive until someone resumes it
      const r = await ScheduleModel.update({ Paused: true, PausedReason: 'failures', UpdatedAt: now })
        .where(scheduleRow(schedule))
        .where('Paused', false)
        .where('ConsecutiveFailures', '>=', pauseAfterFailures);
      paused = r.RowsAffected === 1;
    }

    const row = await ScheduleModel.where(scheduleRow(schedule)).first();
    return { consecutive: row?.ConsecutiveFailures ?? 0, paused };
  }
}
