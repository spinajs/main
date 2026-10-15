import type { Log } from '@spinajs/log-common';
import type { RunStatus, StructuredError } from '../contract.js';
import { jsonColumn } from '../models/converters.js';
import { RunAttemptModel } from '../models/RunAttemptModel.js';
import type { RunModel } from '../models/RunModel.js';
import type { RunEventWriter } from './RunEventWriter.js';

export interface AttemptEnd {
  now: number;
  status: RunStatus;
  reason: string | null;
  error: StructuredError | null;
  /** Written to this attempt's row; omitted to leave the row alone. */
  attemptStatus?: RunStatus;
}

/**
 * Records the end of an attempt whose run row was already updated. The `status` event is what ends
 * run streams and waiters, so a failed attempt-row or `error` write is logged and does not stop it.
 */
export async function journalAttemptEnd(
  run: RunModel,
  end: AttemptEnd,
  events: RunEventWriter,
  log: Log,
): Promise<void> {
  if (end.attemptStatus !== undefined) {
    try {
      await RunAttemptModel.update({
        FinishedAt: end.now,
        Status: end.attemptStatus,
        Error: jsonColumn(end.error) as never,
      })
        .where('RunId', run.Id)
        .where('Attempt', run.Attempt);
    } catch (err) {
      log.warn(err as Error, `run ${run.Id}: could not record the end of attempt ${run.Attempt}`);
    }
  }
  if (end.error) {
    try {
      await events.write(run, run.Attempt, { type: 'error', error: end.error });
    } catch (err) {
      log.warn(err as Error, `run ${run.Id}: could not journal the error of attempt ${run.Attempt}`);
    }
  }
  await events.write(run, run.Attempt, { type: 'status', status: end.status, reason: end.reason });
}
