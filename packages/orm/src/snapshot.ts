/* eslint-disable prettier/prettier */
import _ from 'lodash';
import { DateTime } from 'luxon';
import { IModelDescriptor, IValueConverter } from './interfaces.js';

/**
 * The diff baseline for one model instance.
 *
 * `Columns` holds a *value copy* of every column at the moment the model was hydrated from
 * the database. `Relations` holds, per relation name, the primary keys of the members that
 * were present when that relation was populated.
 *
 * Both must be copies. If a snapshot aliases live state, a later mutation changes the
 * baseline as well, the diff is empty, and `save()` silently does nothing.
 */
export interface IModelSnapshot {
  Columns: Map<string, unknown>;
  Relations: Map<string, unknown[]>;
}

export function createSnapshot(): IModelSnapshot {
  return {
    Columns: new Map<string, unknown>(),
    Relations: new Map<string, unknown[]>(),
  };
}

/**
 * Marker held in a snapshot in place of a value the ORM cannot copy.
 *
 * A baseline that ALIASES a mutable object is the worst possible answer: the baseline
 * mutates along with the model, the diff comes out empty, and `save()` silently drops the
 * caller's edit. This marker is never equal to anything, so such a column is reported as
 * changed on every save — a redundant write instead of a lost one. A converter opts out of
 * the redundancy by implementing `snapshotValue` / `snapshotEquals`.
 */
export const UNCOPYABLE = Symbol('spinajs.orm.snapshot.uncopyable');

/** One column-level difference between a model's baseline and its current values. */
export interface IModelChange {
  Column: string;
  OldValue: unknown;
  NewValue: unknown;
}

/**
 * The baseline value as a change record may carry it. `UNCOPYABLE` is an internal marker for a
 * value the snapshot could not copy; it must never leak out of the ORM, so it is reported as
 * `undefined` ( "no usable old value" ) while the column itself is still reported as changed.
 */
export function baselineValue(value: unknown): unknown {
  return value === UNCOPYABLE ? undefined : value;
}

/**
 * Takes a value copy suitable for a diff baseline.
 *
 * Immutable values (primitives, luxon `DateTime`) are returned as-is. Everything the ORM can
 * put in a column and that can be mutated in place — `Buffer` (binary/UUID columns), `Date`,
 * plain arrays and plain objects (JSON columns) — is copied.
 *
 * A mutable instance of a class the ORM does not own cannot be copied safely: cloning it
 * could break its invariants. Such a value is replaced by {@link UNCOPYABLE} unless its
 * column's converter supplies a `snapshotValue` hook.
 *
 * @param value - the in-memory column value
 * @param converter - the column's converter, when it has one
 */
export function snapshotValue(value: unknown, converter?: IValueConverter | null): unknown {
  if (converter?.snapshotValue) {
    return converter.snapshotValue(value);
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (DateTime.isDateTime(value)) {
    // luxon DateTime is immutable; every "mutation" returns a new instance.
    return value;
  }

  if (Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }

  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  // `Array.isArray` is true for SUBCLASSES of Array too, and `_.cloneDeep` reconstructs those with
  // `new value.constructor()` — no arguments. A subclass whose constructor requires them throws
  // from inside lodash, out of a stack that names neither the model nor the column. The ORM's own
  // `Relation` is exactly such a subclass ( it reads `TargetModel` off its second parameter ), and
  // `@Filterable` on a relation property is enough to route one through here — see
  // `ModelBase.snapshotColumns()`. Only a genuine plain array is safe to clone; anything else is an
  // instance of a class the ORM does not own, which is what UNCOPYABLE is for.
  if ((Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype) || _.isPlainObject(value)) {
    return _.cloneDeep(value);
  }

  return UNCOPYABLE;
}

/**
 * Value equality for a diff. Deliberately stricter than `==`: `null` and `undefined` are
 * different (one is "explicitly cleared", the other "never set"), and `0`/`''`/`false` are
 * never equal to each other.
 *
 * @param a - baseline value
 * @param b - current value
 * @param converter - the column's converter, when it has one
 */
export function snapshotEquals(a: unknown, b: unknown, converter?: IValueConverter | null): boolean {
  if (converter?.snapshotEquals) {
    return converter.snapshotEquals(a, b);
  }

  // Set by `snapshotValue` for a value it could not copy. Never equal to anything, so the
  // column is always reported as changed rather than silently never written.
  if (a === UNCOPYABLE || b === UNCOPYABLE) {
    return false;
  }

  if (a === b) {
    return true;
  }

  if (a === null || a === undefined || b === null || b === undefined) {
    return false;
  }

  if (DateTime.isDateTime(a) && DateTime.isDateTime(b)) {
    return a.toMillis() === b.toMillis();
  }

  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) {
    return a.equals(b);
  }

  if (typeof a === 'object' && typeof b === 'object') {
    return _.isEqual(a, b);
  }

  return false;
}

/**
 * Builds a column snapshot straight from a raw database row, applying the same converters
 * hydration applies. Used by `save({ reload: true })`, which needs the *database's* current
 * values as the baseline without disturbing the user's in-memory edits.
 */
export function snapshotFromRow(descriptor: IModelDescriptor, row: Record<string, unknown>): Map<string, unknown> {
  const columns = new Map<string, unknown>();

  for (const c of descriptor.Columns ?? []) {
    if (!(c.Name in row)) {
      continue;
    }

    // eslint-disable-next-line security/detect-object-injection
    const raw = row[c.Name];
    const converted = c.Converter ? c.Converter.fromDB(raw, row, descriptor.Converters.get(c.Name)?.Options) : raw;

    columns.set(c.Name, snapshotValue(converted, c.Converter));
  }

  return columns;
}
