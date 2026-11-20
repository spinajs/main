import type { ReplayRead } from '@spinajs/authz';

import type { TupleSubjectRef } from '../ir.js';

/**
 * A store row or a logged change that cannot be read as an image (a row that no longer parses, a payload of another
 * shape): replay names a stored-policy store, a contributor's read or its key as a gap.
 */
export class StoreUnreadable extends Error {
  override readonly name = 'StoreUnreadable';
}

/** A set read whose history is incomplete: `known` holds the subjects established at T, `gaps` the keys that are not. */
export class TupleSourceGap extends Error {
  constructor(
    readonly known: readonly TupleSubjectRef[],
    readonly gaps: readonly ReplayRead[],
  ) {
    super(gaps.map((g) => g.reason).join('; '));
  }
}
