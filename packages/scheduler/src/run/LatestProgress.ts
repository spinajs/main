import { Injectable, Singleton } from '@spinajs/di';
import { isTerminalEvent, type RunEvent, type SubscribeTarget } from '../contract.js';
import { defined } from '../models/converters.js';
import { RunModel } from '../models/RunModel.js';
import { RunStepModel } from '../models/RunStepModel.js';
import { iso } from './events.js';

type ProgressEvent = Extract<RunEvent, { type: 'progress' }>;

const MAX_ENDED = 1000;
const hasDetail = (s: RunStepModel) => (s.Done ?? s.Total ?? s.Message ?? null) !== null;
const runKey = (e: RunEvent) => `${e.runId}#${e.attempt}`;
const stepKey = (e: ProgressEvent) => (e.step === null ? '\u0000' : e.step);
// A step's own values: a finished step is not repeated every time the run's percentage moves.
const valuesOf = (e: ProgressEvent) =>
  JSON.stringify(
    e.step === null
      ? [e.progress, e.message ?? null]
      : [e.stepProgress, e.done ?? null, e.total ?? null, e.message ?? null],
  );

/** What one subscription already delivered, per run attempt and step. */
export class ProgressSeen {
  protected steps = new Map<string, Map<string, string>>();
  protected runProgress = new Map<string, number>();
  protected ended = new Set<string>();

  public note(e: RunEvent): void {
    if (isTerminalEvent(e)) {
      this.forgetRun(e.runId);
      return;
    }
    if (e.type !== 'progress') return;
    const key = runKey(e);
    const steps = this.steps.get(key) ?? new Map<string, string>();
    steps.set(stepKey(e), valuesOf(e));
    this.steps.set(key, steps);
    this.runProgress.set(key, e.progress);
  }

  /** The step's values differ from the last `progress` delivered for it. */
  public differs(e: RunEvent): boolean {
    if (e.type !== 'progress' || this.ended.has(e.runId)) return false;
    return this.steps.get(runKey(e))?.get(stepKey(e)) !== valuesOf(e);
  }

  /** The run's percentage differs from the last `progress` delivered for the run. */
  public runProgressDiffers(e: RunEvent): boolean {
    if (e.type !== 'progress' || this.ended.has(e.runId)) return false;
    return this.runProgress.get(runKey(e)) !== e.progress;
  }

  /** A synthetic event built from rows read before the final status must not follow it. */
  protected forgetRun(runId: string): void {
    for (const key of [...this.steps.keys()].filter((k) => k.startsWith(`${runId}#`))) {
      this.steps.delete(key);
      this.runProgress.delete(key);
    }
    this.ended.add(runId);
    if (this.ended.size > MAX_ENDED) this.ended.delete(this.ended.values().next().value as string);
  }
}

/**
 * Rebuilds the latest progress of running runs whose journal stopped storing `progress` rows
 * (per-run cap, R16) from the step and run rows the heartbeat keeps current.
 */
@Singleton()
@Injectable()
export class LatestProgress {
  /**
   * One event per step whose values changed since the subscription last delivered it; when only
   * the run's percentage moved, one event for the last step. Events repeat `cursor` as their
   * position (`seq` on a run stream, `id` on a schedule stream) and are marked `synthetic`.
   */
  public async synthesize(target: SubscribeTarget, seen: ProgressSeen, cursor: number): Promise<RunEvent[]> {
    const byRun = 'runId' in target;
    const query = RunModel.where('Status', 'running').where('ProgressCapped', true);
    const runs = byRun
      ? await query.where('Id', target.runId)
      : await query.where('Schedule', target.schedule).orderBy('CreatedAt');
    const out: RunEvent[] = [];

    for (const run of runs) {
      const base = {
        id: byRun ? 0 : cursor,
        seq: byRun ? cursor : 0,
        runId: run.Id,
        schedule: run.Schedule,
        attempt: run.Attempt,
        ts: iso(run.UpdatedAt ?? run.StartedAt ?? run.CreatedAt) as string,
        synthetic: true as const,
      };
      // step names may repeat: the last row per name wins
      const latest = new Map<string, RunStepModel>();
      for (const s of await RunStepModel.where('RunId', run.Id).where('Attempt', run.Attempt).orderBy('Seq')) {
        latest.set(s.Name, s);
      }
      const reported = [...latest.values()].filter((s) => s.Progress > 0 || hasDetail(s));

      const candidates: ProgressEvent[] = reported.length
        ? reported.map((s) => ({
            ...base,
            type: 'progress' as const,
            progress: run.Progress,
            step: s.Name,
            stepProgress: s.Progress,
            ...defined({ done: s.Done ?? undefined, total: s.Total ?? undefined, message: s.Message ?? undefined }),
          }))
        : [
            {
              ...base,
              type: 'progress' as const,
              progress: run.Progress,
              step: null,
              stepProgress: null,
              ...defined({ message: run.Message ?? undefined }),
            },
          ];

      const changed = candidates.filter((e) => seen.differs(e));
      const last = candidates[candidates.length - 1];
      if (changed.length === 0 && seen.runProgressDiffers(last)) changed.push(last);
      out.push(...changed);
    }
    return out;
  }
}
