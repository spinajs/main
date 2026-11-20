import type { ChangeKind } from '@spinajs/authz';

import type { TupleSubjectRef } from '../ir.js';

/** One key a replay read, and where its state at T came from. `kind` is absent when no contributor serves the relation. */
export interface ReplayRead {
  kind?: ChangeKind;
  key: string;
  origin: 'current' | 'history' | 'gap';
  seq?: number;
  reason?: string;
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
