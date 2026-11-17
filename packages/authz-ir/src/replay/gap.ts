import type { ReplayRead } from '@spinajs/authz';

import type { TupleSubjectRef } from '../ir.js';

/** A stored-policy store whose current rows cannot be read (a row that no longer parses): replay names the store as a gap. */
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
