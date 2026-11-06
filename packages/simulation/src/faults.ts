import { FaultInjector, type FaultPointName } from '@spinajs/durable';
import { currentContext, type SimContext } from './context.js';
import { SimCrash } from './crash.js';
import type { SimRandom } from './random.js';

export interface FaultRule {
  point: FaultPointName;
  when: 'always' | { probability: number } | { nth: number };
  effect: 'crash' | 'delay' | 'duplicate';
  delayMs?: number;
  replica?: string;
}

export interface FaultHit {
  point: string;
  replica: string;
  at: number;
  effect: FaultRule['effect'];
}

/** What a fault does to the simulated world; the environment provides it. */
export interface FaultRuntime {
  now(): number;
  isDead(ctx: SimContext): boolean;
  crash(ctx: SimContext): void;
  park(ctx: SimContext, ms: number): Promise<void>;
}

export type DuplicateListener = (hit: FaultHit, detail: Record<string, unknown> | undefined) => void;

const DETACHED: FaultRuntime = {
  now: () => 0,
  isDead: () => false,
  crash: () => undefined,
  park: () => Promise.resolve(),
};

/**
 * Production code calls `point()` at named places. Outside a simulated replica, or when no rule
 * fires, it does nothing. Rules are tried in order and the first that fires wins; a rule counts
 * only the calls that reach it, which is what `{ nth }` refers to.
 */
export class SimFaults extends FaultInjector {
  public readonly hits: FaultHit[] = [];
  public enabled = true;
  protected runtime: FaultRuntime = DETACHED;
  protected readonly reached = new Map<FaultRule, number>();
  protected readonly listeners: DuplicateListener[] = [];

  constructor(
    protected readonly rules: readonly FaultRule[],
    protected readonly random: SimRandom,
  ) {
    super();
  }

  public attach(runtime: FaultRuntime): void {
    this.runtime = runtime;
  }

  /** A `duplicate` fault only reports the hit: the suite decides what a duplicate means at that point. */
  public onDuplicate(listener: DuplicateListener): void {
    this.listeners.push(listener);
  }

  public point(name: FaultPointName, detail?: Record<string, unknown>): void | Promise<void> {
    const ctx = currentContext();
    if (!ctx) return;
    // leftover async work of a dead incarnation must not get any further
    if (this.runtime.isDead(ctx)) throw new SimCrash(name, ctx.replica);
    if (!this.enabled) return;
    const rule = this.firing(name, ctx.replica);
    if (!rule) return;
    const hit: FaultHit = { point: name, replica: ctx.replica, at: this.runtime.now(), effect: rule.effect };
    this.hits.push(hit);
    switch (rule.effect) {
      case 'crash':
        this.runtime.crash(ctx);
        throw new SimCrash(name, ctx.replica);
      case 'delay':
        return this.runtime.park(ctx, rule.delayMs ?? 0);
      case 'duplicate':
        for (const listener of this.listeners) listener(hit, detail);
        return;
    }
  }

  protected firing(name: string, replica: string): FaultRule | undefined {
    for (const rule of this.rules) {
      if (rule.point !== name || (rule.replica !== undefined && rule.replica !== replica)) continue;
      const n = (this.reached.get(rule) ?? 0) + 1;
      this.reached.set(rule, n);
      const when = rule.when;
      if (when === 'always') return rule;
      if ('nth' in when && when.nth === n) return rule;
      if ('probability' in when && this.random.next() < when.probability) return rule;
    }
    return undefined;
  }
}
