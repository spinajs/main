import { runAuthnBehaviour } from '../behaviour/index.js';
import type { Facet, HarnessFactory, RuleId, RunOptions } from '../behaviour/types.js';

export type StoreConformanceOptions = Omit<RunOptions, 'facets' | 'claim'>;

function runStoreFacets(ids: readonly RuleId[], facets: readonly Facet[], title: string, factory: HarnessFactory, opts: StoreConformanceOptions): void {
  runAuthnBehaviour(ids, factory, { title, ...opts, facets, claim: facets });
}

/** A07, A08 and A09 store facets, all claimed: ports `sessions`, `sessionStorage`, `seed`. */
export function runSessionIssuerConformance(factory: HarnessFactory, opts: StoreConformanceOptions = {}): void {
  runStoreFacets(['A07', 'A08', 'A09'], ['A07/store', 'A08/store', 'A09/store'], 'session issuer conformance', factory, opts);
}

/** A11 store facet, claimed: ports `secrets`, `secretStorage`, `seed`. */
export function runSecretStoreConformance(factory: HarnessFactory, opts: StoreConformanceOptions = {}): void {
  runStoreFacets(['A11'], ['A11/store'], 'secret store conformance', factory, opts);
}

/** A19 store facet, claimed: ports `links`, `seed`. */
export function runLinkStoreConformance(factory: HarnessFactory, opts: StoreConformanceOptions = {}): void {
  runStoreFacets(['A19'], ['A19/store'], 'link store conformance', factory, opts);
}

/** A05 and A06 store facets, claimed: port `throttle` (the throttle and the params it was configured with). */
export function runThrottleConformance(factory: HarnessFactory, opts: StoreConformanceOptions = {}): void {
  runStoreFacets(['A05', 'A06'], ['A05/store', 'A06/store'], 'throttle conformance', factory, opts);
}
