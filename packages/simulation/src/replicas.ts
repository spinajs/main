import type { SimClock } from './clock.js';
import { ownerKey, type SimContext } from './context.js';
import { SimCrash } from './crash.js';

interface Park {
  resolve: () => void;
  reject: (err: unknown) => void;
}

interface Entry {
  incarnation: number;
  crashed: boolean;
  frozenUntil: number | null;
  deferredPark: number | null;
  parks: Park[];
  parkWaiter?: () => void;
}

/** Life cycle of every simulated replica: incarnations, crashes and freezes (GC pauses, partitions). */
export class SimReplicas {
  protected readonly entries = new Map<string, Entry>();

  constructor(protected readonly clock: SimClock) {}

  public context(replica: string): SimContext {
    return { replica, incarnation: this.entry(replica).incarnation };
  }

  public isCrashed(replica: string): boolean {
    return this.entry(replica).crashed;
  }

  public isDead(ctx: SimContext): boolean {
    const e = this.entry(ctx.replica);
    return e.crashed || e.incarnation !== ctx.incarnation;
  }

  public isFrozen(replica: string): boolean {
    return this.entry(replica).frozenUntil !== null;
  }

  /** Kills the incarnation: its timers are dropped and its parked work fails with SimCrash. */
  public crash(ctx: SimContext): void {
    if (this.isDead(ctx)) return;
    const e = this.entry(ctx.replica);
    e.crashed = true;
    e.deferredPark = null;
    this.clock.dropOwner(ownerKey(ctx));
    this.unfreeze(ctx.replica, e);
    for (const park of e.parks.splice(0)) park.reject(new SimCrash('parked', ctx.replica));
  }

  public crashAll(): void {
    for (const replica of [...this.entries.keys()].sort()) this.crash(this.context(replica));
  }

  public restart(replica: string): SimContext {
    const e = this.entry(replica);
    if (!e.crashed) this.crash({ replica, incarnation: e.incarnation });
    e.incarnation++;
    e.crashed = false;
    return { replica, incarnation: e.incarnation };
  }

  public freeze(replica: string, until: number): void {
    if (!Number.isFinite(until)) throw new RangeError(`SimReplicas: cannot freeze ${replica} until ${until}`);
    const e = this.entry(replica);
    e.frozenUntil = Math.max(e.frozenUntil ?? until, until);
    this.clock.freeze(replica);
  }

  /** Suspends the caller for `ms` of simulated time; its replica runs nothing else meanwhile. */
  public park(ctx: SimContext, ms: number): Promise<void> {
    if (this.isDead(ctx)) return Promise.reject(new SimCrash('park', ctx.replica));
    const e = this.entry(ctx.replica);
    this.freeze(ctx.replica, this.clock.now() + ms);
    const parked = new Promise<void>((resolve, reject) => e.parks.push({ resolve, reject }));
    const waiter = e.parkWaiter;
    e.parkWaiter = undefined;
    waiter?.();
    return parked;
  }

  /**
   * Records a pause that must wait for the caller's outermost database transaction to end; the
   * transaction wrapper in SimDatabase.attach takes it. Overlapping requests collapse into the longest.
   */
  public deferPark(ctx: SimContext, ms: number): void {
    if (this.isDead(ctx)) return;
    const e = this.entry(ctx.replica);
    e.deferredPark = Math.max(e.deferredPark ?? ms, ms);
  }

  public takeDeferredPark(ctx: SimContext): number | undefined {
    const e = this.entry(ctx.replica);
    const ms = e.deferredPark;
    e.deferredPark = null;
    return ms === null || this.isDead(ctx) ? undefined : ms;
  }

  /**
   * Resolves on the next park of `replica`. The harness registers it before it starts a tick, so a
   * park in the tick's first synchronous part is seen too.
   */
  public whenParked(replica: string): { parked: Promise<'parked'>; cancel(): void } {
    const e = this.entry(replica);
    let waiter: (() => void) | undefined;
    const parked = new Promise<'parked'>((resolve) => (waiter = () => resolve('parked')));
    e.parkWaiter = waiter;
    return {
      parked,
      cancel: () => {
        if (e.parkWaiter === waiter) e.parkWaiter = undefined;
      },
    };
  }

  /** Frozen replicas whose freeze ended by `now`, by name. */
  public due(now: number): string[] {
    return [...this.entries]
      .filter(([, e]) => e.frozenUntil !== null && e.frozenUntil <= now)
      .map(([name]) => name)
      .sort();
  }

  /** The earliest end of a freeze up to `target`, or null. */
  public nextThaw(target: number): number | null {
    const ends = [...this.entries.values()].map((e) => e.frozenUntil).filter((t): t is number => t !== null && t <= target);
    return ends.length > 0 ? Math.min(...ends) : null;
  }

  /** The latest end of any freeze, or null. */
  public latestFreeze(): number | null {
    const ends = [...this.entries.values()].map((e) => e.frozenUntil).filter((t): t is number => t !== null);
    return ends.length > 0 ? Math.max(...ends) : null;
  }

  /** Ends the freeze and resumes the replica's parked work. */
  public thaw(replica: string): void {
    const e = this.entry(replica);
    this.unfreeze(replica, e);
    for (const park of e.parks.splice(0)) park.resolve();
  }

  protected unfreeze(replica: string, e: Entry): void {
    e.frozenUntil = null;
    this.clock.thaw(replica);
  }

  protected entry(replica: string): Entry {
    let e = this.entries.get(replica);
    if (!e) this.entries.set(replica, (e = { incarnation: 1, crashed: false, frozenUntil: null, deferredPark: null, parks: [] }));
    return e;
  }
}
