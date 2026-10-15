import type { ScheduleDefinition } from '../interfaces.js';
import { RunModel } from '../models/RunModel.js';
import type { RunEventWriter } from './RunEventWriter.js';
import type { RunFinalizer } from './RunFinalizer.js';

export interface CancelDeps {
  events: RunEventWriter;
  finalizer: RunFinalizer;
  def?: ScheduleDefinition;
}

/**
 * Ends a `queued` or `retrying` run as `aborted` / `cancelled`, conditional on the status and attempt
 * observed in `run`. `false` when the run was claimed or changed after it was read.
 */
export async function abortWaitingRun(run: RunModel, now: number, deps: CancelDeps): Promise<boolean> {
  if (run.Status !== 'queued' && run.Status !== 'retrying') return false;
  const r = await RunModel.update({
    Status: 'aborted',
    Reason: 'cancelled',
    CancelRequested: true,
    FinishedAt: now,
    UpdatedAt: now,
    NextAttemptAt: null,
  })
    .where('Id', run.Id)
    .where('Status', run.Status)
    .where('Attempt', run.Attempt);
  if (r.RowsAffected !== 1) return false;

  // the finalizer decides error grouping and health from Reason
  Object.assign(run, {
    Status: 'aborted',
    Reason: 'cancelled',
    CancelRequested: true,
    FinishedAt: now,
    NextAttemptAt: null,
  });
  await deps.events.write(run, run.Attempt, { type: 'status', status: 'aborted', reason: 'cancelled' });
  await deps.finalizer.finalized({
    run,
    def: deps.def,
    status: 'aborted',
    error: null,
    now,
    countsAsFailure: false,
  });
  return true;
}
