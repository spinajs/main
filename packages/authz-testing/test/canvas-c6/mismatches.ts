import type { KnownMismatch } from './conformance.js';
import type { CanvasStoreKind } from './harness.js';

/**
 * Canvas cases where SpinaJS and canvas disagree on purpose until an RFC settles it, per store kind. The
 * tests hold each to the decision the facade gives today, so an engine change shows up as a failure.
 */
export const KNOWN_MISMATCHES: Readonly<Record<CanvasStoreKind, Readonly<Record<string, KnownMismatch>>>> = Object.freeze({
  memory: Object.freeze({}),
  sqlite: Object.freeze({}),
});
