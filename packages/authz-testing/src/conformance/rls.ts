import type * as fc from 'fast-check';

import { principalKey } from '@spinajs/authz';
import type { Permission, Principal } from '@spinajs/authz';

import { check, property } from './common.js';
import type { PropertyRunOptions } from './common.js';

/**
 * `'equal'`: the policy and `.accessible()` return the same rows. `'superset'`: the policy may return more,
 * never fewer (`rls: 'partial'`, and what the session cannot carry: ceilings, delegation, bare-type ancestor
 * assignments, which checks honour and list plans do not).
 */
export type RlsExpectation = 'equal' | 'superset';

export interface RlsComparison {
  readonly principal: Principal;
  readonly permission: Permission;
}

export interface RlsConformanceOptions<W> extends PropertyRunOptions {
  /** Random data: rows, their relations and the authz state that decides them. */
  readonly world: fc.Arbitrary<W>;
  /** Replaces what the database holds with `world`. */
  load(world: W): Promise<void>;
  /** The principals and permissions to compare on `world`. */
  comparisons(world: W): readonly RlsComparison[];
  /** Ids `Model.query().accessible(permission)` returns as `principal`; a `none` plan (AccessDenied) is no row. */
  accessible(principal: Principal, permission: Permission): Promise<readonly string[]>;
  /** Ids a raw `SELECT` returns under the generated policies with `principal`'s session settings. */
  rls(principal: Principal, permission: Permission): Promise<readonly string[]>;
  /** Default `'equal'`. */
  expectation?(world: W, comparison: RlsComparison): RlsExpectation;
}

/** What one comparison got wrong, or undefined: missing rows always, extra rows unless a superset is expected. */
export function rlsMismatch(accessible: readonly string[], rls: readonly string[], expectation: RlsExpectation): string | undefined {
  const policy = new Set(rls);
  const list = new Set(accessible);
  const missing = [...list].filter((id) => !policy.has(id)).sort();
  const extra = expectation === 'equal' ? [...policy].filter((id) => !list.has(id)).sort() : [];
  if (missing.length === 0 && extra.length === 0) return undefined;
  return [missing.length > 0 ? `RLS hides rows .accessible() returns: ${missing.join(', ')}` : '', extra.length > 0 ? `RLS shows rows .accessible() does not: ${extra.join(', ')}` : ''].filter(Boolean).join('; ');
}

/**
 * R3: on random worlds, every principal and permission sees through the generated row level security the
 * rows `.accessible()` gives it (or more, where `expectation` says the policy widens). A failure names the
 * principal, the permission, the rows and the fast-check seed that replays it.
 */
export async function rlsConformance<W>(opts: RlsConformanceOptions<W>): Promise<void> {
  await property(
    'RLS rows differ from .accessible() rows',
    opts.world,
    async (world) => {
      await opts.load(world);
      for (const c of opts.comparisons(world)) {
        const expectation = opts.expectation?.(world, c) ?? 'equal';
        const problem = rlsMismatch(await opts.accessible(c.principal, c.permission), await opts.rls(c.principal, c.permission), expectation);
        check(problem === undefined, () => `${principalKey(c.principal)} ${c.permission} (${expectation}): ${problem}\nworld: ${JSON.stringify(world)}`);
      }
    },
    { numRuns: opts.numRuns ?? 25, ...(opts.seed === undefined ? {} : { seed: opts.seed }) },
  );
}
