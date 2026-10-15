import type { StepStatus } from '../contract.js';
import type { ScheduleDefinition } from '../interfaces.js';
import type { RunModel } from '../models/RunModel.js';
import { RunStepModel } from '../models/RunStepModel.js';

export interface StepRecord {
  Attempt: number;
  Seq: number;
  Name: string;
  Status: StepStatus;
  Result: unknown;
  /** `false`: the step's value was not kept, so it has to run again. Absent counts as stored. */
  ResultStored?: boolean;
}

/**
 * Results of completed steps keyed `${name}#${occurrence}` (occurrence counts repeated names within
 * one attempt). With `fromStep`, that step and everything after it in the latest attempt that ran it
 * are left out; so are steps whose value was not stored.
 */
export function buildResumeMap(rows: StepRecord[], fromStep?: string): Map<string, unknown> {
  const sorted = [...rows].sort((a, b) => a.Attempt - b.Attempt || a.Seq - b.Seq);
  const counters = new Map<number, Map<string, number>>();
  const keyed = sorted.map((row) => {
    const c = counters.get(row.Attempt) ?? new Map<string, number>();
    counters.set(row.Attempt, c);
    const n = (c.get(row.Name) ?? 0) + 1;
    c.set(row.Name, n);
    return { key: `${row.Name}#${n}`, row };
  });

  let excluded = new Set<string>();
  if (fromStep !== undefined) {
    const attempts = [...new Set(sorted.map((r) => r.Attempt))].reverse();
    for (const a of attempts) {
      const inAttempt = keyed.filter((x) => x.row.Attempt === a);
      const idx = inAttempt.findIndex((x) => x.row.Name === fromStep);
      if (idx >= 0) {
        excluded = new Set(inAttempt.slice(idx).map((x) => x.key));
        break;
      }
    }
  }

  const map = new Map<string, unknown>();
  for (const { key, row } of keyed) {
    if (excluded.has(key)) continue;
    if ((row.Status === 'succeeded' || row.Status === 'skipped') && row.ResultStored !== false)
      map.set(key, row.Result);
  }
  return map;
}

/**
 * What a new attempt may skip: the steps of the run a manual retry resumes (`ResumeFrom`), and, on an
 * automatic retry of a resumable or resumed run, the steps this run's earlier attempts completed.
 * `null` when nothing is resumed.
 */
export async function loadResumeMap(run: RunModel, def: ScheduleDefinition): Promise<Map<string, unknown> | null> {
  const from = run.ResumeFrom ?? null;
  if (!from && !(def.resumable && run.Attempt > 1)) return null;

  const map = from
    ? buildResumeMap(await RunStepModel.where('RunId', from.runId), from.fromStep)
    : new Map<string, unknown>();
  // the run's own attempts come later than the resumed run's, so their results win
  const own = await RunStepModel.where('RunId', run.Id);
  for (const [key, value] of buildResumeMap(own)) map.set(key, value);
  return map;
}
