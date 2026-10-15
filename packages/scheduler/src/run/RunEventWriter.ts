import { Autoinject, Injectable, Singleton } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { isTerminalStatus, type RunEvent, type RunEventPayload } from '../contract.js';
import { RunLogModel } from '../models/RunLogModel.js';
import { DbClock } from '../time/clock.js';
import { appendJournalRow } from './journal.js';
import { RunEventHub } from './RunEventHub.js';

const CAPPED = new Set(['log', 'message', 'progress']);
const MAX_MESSAGE = 2000;
const MAX_CACHED_RUNS = 10_000;

interface RunCache {
  seq?: number;
  counts: Map<string, number>;
}

function columnsOf(p: RunEventPayload): { Level: string | null; Step: string | null; Message: string | null } {
  const level = 'level' in p ? p.level : p.type === 'error' ? 'error' : null;
  const step = 'step' in p ? p.step ?? null : p.type === 'error' ? p.error.step ?? null : null;
  const message =
    'message' in p && typeof p.message === 'string' ? p.message : p.type === 'error' ? p.error.message : null;
  return { Level: level, Step: step, Message: message === null ? null : message.slice(0, MAX_MESSAGE) };
}

@Singleton()
@Injectable()
export class RunEventWriter {
  @Autoinject(RunEventHub)
  protected Hub: RunEventHub;

  @Autoinject(DbClock)
  protected Clock: DbClock;

  @Config('scheduler.runLogLimit', { defaultValue: 1000 })
  protected Limit: number;

  /** Per-run seq and cap counters; a stale or evicted entry is reloaded from the journal. */
  protected cache = new Map<string, RunCache>();
  protected tails = new Map<string, Promise<unknown>>();

  /** Journals and publishes one event; `null` when the per-run cap dropped it. */
  public write(
    run: { Id: string; Schedule: string },
    attempt: number,
    payload: RunEventPayload,
  ): Promise<RunEvent | null> {
    // Writes of one run are serialized so seq order is commit and publish order.
    const prev = this.tails.get(run.Id) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.append(run, attempt, payload));
    this.tails.set(run.Id, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.tails.get(run.Id) === next) this.tails.delete(run.Id);
      });
    return next;
  }

  /** Drops the cached state of a run; done automatically when a terminal status is written. */
  public forget(runId: string): void {
    this.cache.delete(runId);
  }

  protected async append(
    run: { Id: string; Schedule: string },
    attempt: number,
    payload: RunEventPayload,
  ): Promise<RunEvent | null> {
    const c = this.cached(run.Id);
    const capped = CAPPED.has(payload.type);
    if (capped && (await this.storedCount(c, run.Id, payload.type)) >= this.Limit) return null;

    let lastError: unknown;
    for (let i = 0; i < 3; i++) {
      const seq = await this.nextSeq(c, run.Id);
      const ts = this.Clock.now();
      try {
        const row = await appendJournalRow({
          RunId: run.Id,
          Schedule: run.Schedule,
          Seq: seq,
          Attempt: attempt,
          Ts: ts,
          Kind: payload.type,
          ...columnsOf(payload),
          Data: payload,
        });
        if (capped) c.counts.set(payload.type, (c.counts.get(payload.type) ?? 0) + 1);
        const event = {
          ...payload,
          id: row.Pos,
          seq,
          runId: run.Id,
          schedule: run.Schedule,
          attempt,
          ts: new Date(ts).toISOString(),
        } as RunEvent;
        this.Hub.publish(event);
        if (payload.type === 'status' && isTerminalStatus(payload.status)) this.forget(run.Id);
        return event;
      } catch (err) {
        // (RunId, Seq) collided with a row another replica added (e.g. the reaper); re-read the sequence
        lastError = err;
        c.seq = undefined;
      }
    }
    throw lastError;
  }

  protected cached(runId: string): RunCache {
    const c = this.cache.get(runId) ?? { counts: new Map<string, number>() };
    // re-insert so the map stays in least-recently-used order
    this.cache.delete(runId);
    this.cache.set(runId, c);
    if (this.cache.size > MAX_CACHED_RUNS) this.cache.delete(this.cache.keys().next().value as string);
    return c;
  }

  protected async nextSeq(c: RunCache, runId: string): Promise<number> {
    if (c.seq === undefined) {
      const last = await RunLogModel.where('RunId', runId).orderByDescending('Seq').first();
      c.seq = last ? last.Seq : 0;
    }
    c.seq += 1;
    return c.seq;
  }

  protected async storedCount(c: RunCache, runId: string, kind: string): Promise<number> {
    let n = c.counts.get(kind);
    if (n === undefined) {
      // Postgres returns COUNT(*) as an int8 string
      n = Number(await RunLogModel.count((b) => b.where('RunId', runId).where('Kind', kind)));
      c.counts.set(kind, n);
    }
    return n;
  }
}
