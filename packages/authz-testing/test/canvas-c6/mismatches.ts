import type { DenyReason } from './c6/authz.js';
import type { KnownMismatch } from './conformance.js';
import type { CanvasStoreKind } from './harness.js';

// C6 has no model_error code; the facade passes the engine's code through as it does for other unknown codes.
const MODEL_ERROR: KnownMismatch['got'] = Object.freeze({ allowed: false, reason: Object.freeze({ code: 'model_error' }) as unknown as DenyReason });

// K1-2: DbScopeAttributeStore.get throws for a ref id over 64 characters, and a branch id (project:file:name)
// is longer, so reading resource.name of a branch makes the RBAC vote indeterminate.
const K1_2 = Object.freeze({ rfc: 'K1-2', got: MODEL_ERROR });

/**
 * Canvas cases where SpinaJS and canvas disagree on purpose until an RFC settles it, per store kind. The
 * tests hold each to the decision the facade gives today, so an engine change shows up as a failure.
 */
export const KNOWN_MISMATCHES: Readonly<Record<CanvasStoreKind, Readonly<Record<string, KnownMismatch>>>> = Object.freeze({
  memory: Object.freeze({}),
  sqlite: Object.freeze({
    'editor edits unprotected branches': K1_2,
    'main needs maintainer to push': K1_2,
    'release push is open to editors': K1_2,
    'release merge needs maintainer': K1_2,
    'overlapping branch rules report the first pattern by code point': K1_2,
  }),
});
