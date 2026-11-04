import { NonDeterminismError } from './errors.js';
import type { StepRow } from './journal.js';

// Turns without a live operation that a replay waits for the next recorded call before it counts as diverged. A
// released result's continuation runs as microtasks, which drain before the next setImmediate; two more turns cover
// code that hops through one setImmediate itself. No wall-clock time, so a slow machine cannot trip it.
const IDLE_TURNS = 3;

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const settled = (p: Promise<unknown>): Promise<unknown> => p.then(undefined, () => undefined);

interface Waiter {
  resolve(): void;
  reject(err: unknown): void;
}

/**
 * Hands recorded results back in the order the run that wrote them delivered them (`Meta.order`), one per turn, so
 * concurrent branches continue in their original interleaving and a later same-name step gets its original occurrence.
 */
export class ReplayGate {
  protected readonly order: string[];
  protected readonly held: Set<string>;
  protected readonly waiting = new Map<string, Waiter>();
  protected cursor = 0;
  protected driving = false;

  constructor(rows: StepRow[], protected readonly live: () => Promise<unknown>[]) {
    const ordered = rows.filter((r) => (r.Status === 'succeeded' || r.Status === 'failed') && typeof r.Meta?.order === 'number');
    this.order = ordered.sort((a, b) => (a.Meta?.order ?? 0) - (b.Meta?.order ?? 0)).map((r) => r.Key);
    this.held = new Set(this.order);
  }

  public wait(key: string): Promise<void> {
    if (!this.held.has(key)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.waiting.set(key, { resolve, reject });
      if (!this.driving) void this.drive();
    });
  }

  protected async drive(): Promise<void> {
    this.driving = true;
    let idle = 0;
    while (this.waiting.size > 0) {
      const key = this.order[this.cursor];
      const waiter = this.waiting.get(key);
      const live = this.live();
      if (waiter) {
        this.waiting.delete(key);
        this.cursor++;
        idle = 0;
        waiter.resolve();
      } else if (live.length > 0) {
        idle = 0;
        await Promise.race(live.map(settled));
      } else if (++idle > IDLE_TURNS) {
        this.diverged(key);
        break;
      }
      await nextTurn();
    }
    this.driving = false;
  }

  protected diverged(missing: string): void {
    for (const [key, w] of this.waiting) w.reject(new NonDeterminismError(`the journal delivered '${missing}' before '${key}', this run never asked for it`));
    this.waiting.clear();
  }
}
