import { AsyncLocalStorage } from 'node:async_hooks';
import { Clock, DbTimeSource, type TimerHandle } from '@spinajs/durable';
import { currentContext, ownerKey } from './context.js';

/** 2026-01-05T10:00:00Z. A fixed start keeps persisted times identical between two runs of a seed. */
export const SIM_EPOCH = Date.UTC(2026, 0, 5, 10, 0, 0);

interface SimTimer {
  id: number;
  at: number;
  every: number | null;
  owner: string | null;
  replica: string | null;
  fire: () => void;
}

/** Virtual time. Timers fire only when the harness moves the clock, each in the async context that created it. */
export class SimClock extends Clock {
  protected current: number;
  protected nextId = 1;
  protected readonly timers = new Map<number, SimTimer>();
  protected readonly frozen = new Set<string>();
  protected readonly dead = new Set<string>();
  protected readonly failures: unknown[] = [];

  constructor(start: number = SIM_EPOCH) {
    super();
    this.current = start;
  }

  public now(): number {
    return this.current;
  }

  public setTimeout(fn: () => void, ms: number): TimerHandle {
    return this.add(fn, ms, null);
  }

  public clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }

  public setInterval(fn: () => void, ms: number): TimerHandle {
    return this.add(fn, ms, Math.max(1, ms));
  }

  public clearInterval(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }

  public get pending(): number {
    return this.timers.size;
  }

  /**
   * Fires every timer due up to `now + ms` in due order, then sets the time to `now + ms`. The
   * callbacks run synchronously with no microtask drain in between, so their promise continuations
   * run only after this returns. For multi-hop async work, call `fireNext` and settle between calls.
   */
  public advance(ms: number): void {
    const target = this.target(ms);
    let fired = this.fireNext(target);
    while (fired) fired = this.fireNext(target);
    this.current = target;
  }

  /** The due time of the earliest timer that would fire by `target`, or null. */
  public nextDue(target: number): number | null {
    return this.earliest(target)?.at ?? null;
  }

  /**
   * Fires the earliest timer due by `target` (ties in creation order) at its due instant and reports
   * whether one fired. The harness settles the database between two calls, so the async work one
   * timer starts never interleaves with another's.
   */
  public fireNext(target: number): boolean {
    const next = this.earliest(target);
    if (!next) return false;
    this.current = Math.max(this.current, next.at);
    if (next.every === null) this.timers.delete(next.id);
    else next.at = this.current + next.every;
    try {
      next.fire();
    } catch (err) {
      this.failures.push(err);
    }
    return true;
  }

  /** Moves the time without firing anything; overdue timers fire on the next advance. */
  public jump(ms: number): void {
    this.current = this.target(ms);
  }

  public freeze(replica: string): void {
    this.frozen.add(replica);
  }

  public thaw(replica: string): void {
    this.frozen.delete(replica);
  }

  /** A crashed incarnation's timers never fire, and the ones it still creates are discarded. */
  public dropOwner(owner: string): void {
    this.dead.add(owner);
    for (const [id, timer] of this.timers) if (timer.owner === owner) this.timers.delete(id);
  }

  /** What timer callbacks threw synchronously since the last call. */
  public takeFailures(): unknown[] {
    return this.failures.splice(0);
  }

  protected earliest(target: number): SimTimer | undefined {
    let next: SimTimer | undefined;
    for (const timer of this.timers.values()) {
      if (timer.at > target || (timer.replica !== null && this.frozen.has(timer.replica))) continue;
      if (!next || timer.at < next.at || (timer.at === next.at && timer.id < next.id)) next = timer;
    }
    return next;
  }

  protected target(ms: number): number {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`SimClock: cannot move by ${ms} ms`);
    return this.current + ms;
  }

  protected add(fn: () => void, ms: number, every: number | null): number {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`SimClock: invalid timer delay ${ms} ms`);
    const id = this.nextId++;
    const ctx = currentContext();
    const owner = ctx ? ownerKey(ctx) : null;
    if (owner !== null && this.dead.has(owner)) return id;
    const restore = AsyncLocalStorage.snapshot();
    this.timers.set(id, { id, at: this.current + ms, every, owner, replica: ctx?.replica ?? null, fire: () => restore(fn) });
    return id;
  }
}

/** Database time is simulated time, so every replica's DbClock offset is zero. */
export class SimDbTimeSource extends DbTimeSource {
  constructor(protected readonly clock: SimClock) {
    super();
  }

  public read(): Promise<number> {
    return Promise.resolve(this.clock.now());
  }
}
