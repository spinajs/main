import type { KnownMismatch } from './conformance.js';
import type { CanvasStoreKind } from './harness.js';
import type { CanvasSqlKind } from './sql-harness.js';

/**
 * Canvas cases where SpinaJS and canvas disagree on purpose until an RFC settles it, per store kind. The
 * tests hold each to the decision the facade gives today, so an engine change shows up as a failure.
 */
export const KNOWN_MISMATCHES: Readonly<Record<CanvasStoreKind, Readonly<Record<string, KnownMismatch>>>> = Object.freeze({
  memory: Object.freeze({}),
  sqlite: Object.freeze({}),
});

export interface KnownListMismatch {
  readonly rfc: string;
  /** Exactly the `listProblems` lines the list shows today. */
  readonly problems: readonly string[];
  /** The cause the RFC names: the residual is FALSE and the type-level request has this TRUE deny (`<model> <code> (<policy>)`). */
  readonly falseBecause: string;
}

/** Canvas lists whose SQL and check disagree until an RFC settles it, per dialect, by list key. */
export const LIST_MISMATCHES: Readonly<Record<CanvasSqlKind, Readonly<Record<string, KnownListMismatch>>>> = Object.freeze({
  sqlite: Object.freeze({}),
  postgres: Object.freeze({}),
});
