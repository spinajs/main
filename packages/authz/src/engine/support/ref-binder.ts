import { bindRefs } from '../../contracts/filter.js';
import type { ResourceFilter } from '../../contracts/filter.js';
import type { Principal, ResourceRef } from '../../contracts/principal.js';
import { cacheSafeRef } from '../cache-key.js';
import { bindEngineRefs, collectRefs, refValues, scopeNodes } from '../refs.js';
import { NEEDS_ASYNC, settleWithin } from '../run.js';
import type { Pipeline } from '../run.js';
import { describeError } from '../vote.js';
import type { Attributes, BoundAttributes } from '../types.js';
import type { ReadRecorder } from './reads.js';

export const TIMED_OUT: unique symbol = Symbol('timed out');

export type Bounded = { readonly kind: 'value'; readonly value: unknown } | { readonly kind: 'error'; readonly error: unknown } | { readonly kind: 'timeout' };

/** `settleWithin` that keeps a rejection (with its error) apart from a timeout. Never rejects. */
export function bounded(load: () => unknown, ms: number): Promise<Bounded> {
  const outcome = Promise.resolve()
    .then(load)
    .then(
      (value): Bounded => ({ kind: 'value', value }),
      (error): Bounded => ({ kind: 'error', error }),
    );
  return settleWithin(outcome, ms, describeError, 'scope attribute load').then((s): Bounded => (s.ok ? (s.value as Bounded) : { kind: 'timeout' }));
}

/**
 * Step 11 for one check: `bindRefs`, then actor.* and scope.* refs. `cover`
 * loads the scope nodes the refs of some filters need (each type once);
 * `bind` is sync, and a scope ref of a type no `cover` loaded binds as
 * missing, so every ref is gone either way.
 */
export class RefBinder {
  private readonly attributes = new Map<string, Attributes>();

  constructor(
    private readonly scope: { readonly principal: Principal; readonly env: Readonly<Record<string, unknown>> },
    private readonly actor: Principal,
    /** undefined for a ref without id: only $global resolves then. */
    private readonly ancestors: readonly ResourceRef[] | undefined,
    private readonly sync: boolean,
    private readonly load: (node: ResourceRef) => Promise<BoundAttributes>,
    private readonly reads?: ReadRecorder,
  ) {}

  /** `uncacheable`: a filter read a ref the L2 key does not hold (refs read before `bindRefs`, which replaces principal.* and env.*), or a load it needed was degraded. */
  *cover(filters: readonly ResourceFilter[]): Pipeline<{ readonly failed: boolean; readonly degraded: boolean; readonly uncacheable: boolean }> {
    let uncacheable = false;
    const refs = new Set<string>();
    for (const f of filters) {
      if (!collectRefs(f).every(cacheSafeRef)) uncacheable = true;
      for (const r of collectRefs(bindRefs(f, this.scope))) refs.add(r);
    }
    const nodes = [...scopeNodes([...refs], { ancestors: this.ancestors })].filter(([type]) => !this.attributes.has(type));
    if (nodes.length === 0) return { failed: false, degraded: false, uncacheable };
    if (this.sync) yield NEEDS_ASYNC;
    const loaded = (yield Promise.all(nodes.map(([, node]) => this.load(node)))) as readonly BoundAttributes[];
    nodes.forEach(([type, node], i) => {
      this.attributes.set(type, loaded[i].attributes);
      this.reads?.attribute(node, '', loaded[i].attributes);
    });
    const degraded = loaded.some((l) => l.degraded);
    return { failed: loaded.some((l) => l.failed), degraded, uncacheable: uncacheable || degraded };
  }

  bind(f: ResourceFilter): ResourceFilter {
    const pre = bindRefs(f, this.scope);
    return bindEngineRefs(pre, refValues(collectRefs(pre), this.actor, this.attributes));
  }

  /** The first scope.* ref of `filters` without a value from the nodes `cover` loaded. */
  missingScopeRef(filters: readonly ResourceFilter[]): string | undefined {
    for (const f of filters) {
      const refs = collectRefs(bindRefs(f, this.scope)).filter((r) => r.startsWith('scope.'));
      const values = refValues(refs, this.actor, this.attributes);
      const missing = refs.find((r) => !values.has(r));
      if (missing !== undefined) return missing;
    }
    return undefined;
  }
}
