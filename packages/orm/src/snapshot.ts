/* eslint-disable prettier/prettier */
import _ from 'lodash';
import { DateTime } from 'luxon';
import { IModelDescriptor } from './interfaces.js';

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
 * Takes a value copy suitable for a diff baseline.
 *
 * Immutable values (primitives, luxon `DateTime`) are returned as-is. Everything the ORM can
 * put in a column and that can be mutated in place — `Buffer` (binary/UUID columns), `Date`,
 * arrays and plain objects (JSON columns) — is copied. Class instances the ORM does not own
 * are returned as-is: cloning them could break invariants, and a converter that produces one
 * is responsible for its own equality via `snapshotEquals`.
 */
export function snapshotValue(value: unknown): unknown {
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

  if (Array.isArray(value) || _.isPlainObject(value)) {
    return _.cloneDeep(value);
  }

  return value;
}

/**
 * Value equality for a diff. Deliberately stricter than `==`: `null` and `undefined` are
 * different (one is "explicitly cleared", the other "never set"), and `0`/`''`/`false` are
 * never equal to each other.
 */
export function snapshotEquals(a: unknown, b: unknown): boolean {
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

    columns.set(c.Name, snapshotValue(converted));
  }

  return columns;
}
