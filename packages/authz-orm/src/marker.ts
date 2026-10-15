import type { Permission, ResourceRef } from '@spinajs/authz';

const MARKS = Symbol.for('@spinajs/authz-orm:marks');

/** What `.accessible()`, `.unscoped()` and `.withAccess()` (lane L4) declared on one builder. */
export interface AccessMarks {
  readonly accessible?: Permission;
  /** Request env for the access plans (`accessPlan`'s `env`). */
  readonly env?: Readonly<Record<string, unknown>>;
  readonly unscoped?: string;
  readonly withAccess?: readonly Permission[];
  /** `.within()` calls: the refs of one call are OR-ed, the calls are AND-ed. */
  readonly within?: readonly (readonly ResourceRef[])[];
}

export function marksOf(builder: object): AccessMarks | undefined {
  return (builder as Record<symbol, AccessMarks | undefined>)[MARKS];
}

export function setMarks(builder: object, marks: AccessMarks): void {
  Object.defineProperty(builder, MARKS, { value: Object.freeze({ ...marks }), configurable: true, writable: true, enumerable: false });
}
