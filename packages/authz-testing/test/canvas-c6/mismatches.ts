import type { KnownMismatch } from './conformance.js';

/**
 * Canvas cases where SpinaJS and canvas disagree on purpose until an RFC settles it. The tests hold
 * each to the decision the facade gives today, so an engine change shows up as a failure.
 */
export const KNOWN_MISMATCHES: Readonly<Record<string, KnownMismatch>> = Object.freeze({});
