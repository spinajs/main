import { Autoinject, Injectable, Singleton } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import type { RunEvent, RunEventPayload } from '../contract.js';
import { RunLogModel } from '../models/RunLogModel.js';
import { DbClock } from '../time/clock.js';
import { appendJournalRow } from './journal.js';
import { RunEventHub } from './RunEventHub.js';

const CAPPED = new Set(['log', 'message', 'progress']);
const MAX_MESSAGE = 2000;

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

  protected seqs = new Map<string, number>();
  protected counts = new Map<string, number>();
  protected tails = new Map<string, Promise<unknown>>();

  /** Journals and publishes one event; `null` when the per-run cap dropped it. */
  public write(
    run: { Id: string; Schedule: string },
    attempt: number,
    payload: RunEventPayload,
  ): Promise<RunEvent | null> {
    // Writes of one run are serialized so seq order is commit and publish order: a live run
    // stream drops an event whose seq is below one it already delivered.
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

  public forget(runId: string): void {
    this.seqs.delete(runId);
    for (const key of [...this.counts.keys()]) if (key.startsWith(`${runId}:`)) this.counts.delete(key);
  }

  protected async append(
    run: { Id: string; Schedule: string },
    attempt: number,
    payload: RunEventPayload,
  ): Promise<RunEvent | null> {
    if (CAPPED.has(payload.type) && !(await this.withinCap(run.Id, payload.type))) return null;

    let lastError: unknown;
    for (let i = 0; i < 3; i++) {
      const seq = await this.nextSeq(run.Id);
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
        return event;
      } catch (err) {
        // (RunId, Seq) collided with a row another replica added (e.g. the reaper); re-read the sequence
        lastError = err;
        this.seqs.delete(run.Id);
      }
    }
    throw lastError;
  }

  protected async nextSeq(runId: string): Promise<number> {
    let current = this.seqs.get(runId);
    if (current === undefined) {
      const last = await RunLogModel.where('RunId', runId).orderByDescending('Seq').first();
      current = last ? last.Seq : 0;
    }
    current += 1;
    this.seqs.set(runId, current);
    return current;
  }

  protected async withinCap(runId: string, kind: string): Promise<boolean> {
    const key = `${runId}:${kind}`;
    let n = this.counts.get(key);
    // Postgres returns COUNT(*) as an int8 string
    if (n === undefined) n = Number(await RunLogModel.count((b) => b.where('RunId', runId).where('Kind', kind)));
    if (n >= this.Limit) return false;
    this.counts.set(key, n + 1);
    return true;
  }
}
