import type { RunEvent } from '../contract.js';
import type { RunLogModel } from '../models/RunLogModel.js';

export function iso(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

export function toRunEvent(row: RunLogModel): RunEvent {
  return {
    ...(row.Data as object),
    id: row.Pos,
    seq: row.Seq,
    runId: row.RunId,
    schedule: row.Schedule,
    attempt: row.Attempt,
    ts: iso(row.Ts)!,
  } as RunEvent;
}
