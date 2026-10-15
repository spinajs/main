import type { Log } from '@spinajs/log-common';
import type { ScheduleDefinition } from '../interfaces.js';
import { RunModel } from '../models/RunModel.js';
import { journalAttemptEnd } from './end.js';
import type { RunEventWriter } from './RunEventWriter.js';
import type { RunFinalizer } from './RunFinalizer.js';

export interface CancelDeps {
  events: RunEventWriter;
  finalizer: RunFinalizer;
  log: Log;
  def?: ScheduleDefinition;
}

/**
 * Ends a `queued`, `retrying` or `emitted` run as `aborted` / `cancelled`, conditional on the status and
 * attempt observed in `run`. `false` when the run was claimed, mirrored or changed after it was read.
 * An emitted run's queue job is not recalled; the run only stops tracking it.
 */
export async function abortWaitingRun(run: RunModel, now: number, deps: CancelDeps): Promise<boolean> {
  if (run.Status !== 'queued' && run.Status !== 'retrying' && run.Status !== 'emitted') return false;
  const observed = run.Status;
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
  await journalAttemptEnd(
    run,
    {
      now,
      status: 'aborted',
      reason: 'cancelled',
      error: null,
      // a queued or retrying run has no open attempt row
      attemptStatus: observed === 'emitted' ? 'aborted' : undefined,
    },
    deps.events,
    deps.log,
  );
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
