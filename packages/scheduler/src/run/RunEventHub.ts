import { EventEmitter } from 'events';
import { Autoinject, Injectable, Singleton } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import type { RunEvent, RunEventListener, SubscribeOptions, SubscribeTarget, Unsubscribe } from '../contract.js';
import { RunLogModel } from '../models/RunLogModel.js';
import { Clock } from '../time/clock.js';
import { toRunEvent } from './events.js';

const keyOf = (t: SubscribeTarget) => ('runId' in t ? `run:${t.runId}` : `schedule:${t.schedule}`);
const PAGE = 500;

/**
 * Live run events, replayed from the journal and then delivered as they happen.
 *
 * A schedule stream's cursor is the global journal position `Pos` (R15) and is fed only from the
 * journal: delivering a local event directly could move the cursor past a lower position another
 * replica committed just before, which this process has not read yet. Local events only wake a fetch.
 *
 * A run stream's cursor is the per-run `seq`, which is dense in commit order. A local event is
 * delivered directly only when it is the next seq; anything else (another replica, e.g. the
 * reaper, wrote in between) wakes a fetch instead, so no lower seq is skipped.
 */
@Singleton()
@Injectable()
export class RunEventHub {
  @Autoinject(Clock)
  protected Clock: Clock;

  @Config('scheduler.events.pollInterval', { defaultValue: 1000 })
  protected PollInterval: number;

  protected emitter = new EventEmitter().setMaxListeners(0);

  public publish(e: RunEvent): void {
    this.emitter.emit(`run:${e.runId}`, e);
    this.emitter.emit(`schedule:${e.schedule}`, e);
  }

  /**
   * Replays journal rows after `options.after`, then goes live. Without `after`, a run target
   * replays from its first event and a schedule target starts after the schedule's newest row.
   */
  public async subscribe(
    target: SubscribeTarget,
    listener: RunEventListener,
    options: SubscribeOptions = {},
  ): Promise<Unsubscribe> {
    const byRun = 'runId' in target;
    const cursorOf = (e: RunEvent) => (byRun ? e.seq : e.id);
    let cursor = options.after ?? 0;
    let closed = false;
    let ready = false;
    let wokenBeforeReady = false;
    const buffered: RunEvent[] = [];

    const deliver = (e: RunEvent) => {
      if (closed || cursorOf(e) <= cursor) return;
      cursor = cursorOf(e);
      listener(e);
    };

    // One fetch at a time; a wake-up during a fetch runs one more round after it.
    let fetching: Promise<void> | null = null;
    let again = false;
    const poll = (): Promise<void> => {
      if (fetching) {
        again = true;
        return fetching;
      }
      const rounds = async () => {
        try {
          do {
            again = false;
            let page: RunEvent[];
            do {
              page = await this.fetchAfter(target, cursor, PAGE);
              for (const e of page) deliver(e);
            } while (page.length === PAGE && !closed);
          } while (again && !closed);
        } finally {
          // same microtask as the last `again` check, so a wake-up cannot fall in between
          fetching = null;
        }
      };
      fetching = rounds();
      return fetching;
    };
    const wake = () => void poll().catch(() => undefined);

    const offer = (e: RunEvent) => {
      if (e.seq === cursor + 1) deliver(e);
      else if (e.seq > cursor) wake();
    };

    const live = (e: RunEvent) => {
      if (closed) return;
      if (!ready) {
        if (byRun) buffered.push(e);
        else wokenBeforeReady = true;
      } else if (byRun) offer(e);
      else wake();
    };

    const key = keyOf(target);
    this.emitter.on(key, live);
    try {
      if (options.after === undefined && !byRun) cursor = await this.lastPosition(target.schedule);
      else await poll();
      ready = true;
      if (byRun) buffered.sort((a, b) => a.seq - b.seq).forEach(offer);
      else if (wokenBeforeReady) await poll();
    } catch (err) {
      closed = true;
      this.emitter.off(key, live);
      throw err;
    } finally {
      buffered.length = 0;
    }

    let polling = false;
    const timer = this.Clock.setInterval(() => {
      if (polling || closed) return;
      polling = true;
      void poll()
        .catch(() => undefined)
        .finally(() => (polling = false));
    }, this.PollInterval);

    return () => {
      closed = true;
      this.emitter.off(key, live);
      this.Clock.clearInterval(timer);
    };
  }

  public async fetchAfter(target: SubscribeTarget, cursor: number, limit = PAGE): Promise<RunEvent[]> {
    const rows =
      'runId' in target
        ? await RunLogModel.where('RunId', target.runId).where('Seq', '>', cursor).orderBy('Seq').take(limit)
        : await RunLogModel.where('Schedule', target.schedule).where('Pos', '>', cursor).orderBy('Pos').take(limit);
    return rows.map(toRunEvent);
  }

  protected async lastPosition(schedule: string): Promise<number> {
    return (await RunLogModel.where('Schedule', schedule).orderByDescending('Pos').first())?.Pos ?? 0;
  }
}
