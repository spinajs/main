/* eslint-disable prettier/prettier */
import _ from 'lodash';
import { v4 as uuidv4 } from 'uuid';
import { SortOrder, SqlOperator } from './enums.js';
import { OrmException } from './exceptions.js';
import { IModelDescriptor, IOrderByBuilder, IWhereBuilder, PrimaryKeyGeneration } from './interfaces.js';

/**
 * Separator used when flattening a composite key into one string. NUL never appears in an
 * identifier and the parts are length-prefixed, so two different tuples cannot collide.
 */
const PK_SEPARATOR = '\u0000';

/** Primary key column names in declaration order. Empty when the model has no @Primary(). */
export function pkColumns(descriptor: IModelDescriptor): string[] {
  return descriptor.PrimaryKey ?? [];
}

export function hasPk(descriptor: IModelDescriptor): boolean {
  return pkColumns(descriptor).length !== 0;
}

export function isCompositePk(descriptor: IModelDescriptor): boolean {
  return pkColumns(descriptor).length > 1;
}

/**
 * Coerces one primary key value into an ordered tuple matching `pkColumns(descriptor)`.
 * Accepts a scalar or a one-element array for single-column keys, and an array in key order
 * or a plain object keyed by column name for composite keys.
 */
export function normalizePkTuple(descriptor: IModelDescriptor, value: any): any[] {
  const keys = pkColumns(descriptor);

  if (keys.length === 0) {
    throw new OrmException(`model ${descriptor.Name} has no primary key`);
  }

  if (keys.length === 1) {
    return [Array.isArray(value) ? value[0] : value];
  }

  if (Array.isArray(value)) {
    if (value.length !== keys.length) {
      throw new OrmException(`composite primary key of ${descriptor.Name} expects ${keys.length} values (${keys.join(', ')}), got ${value.length}`);
    }
    return value;
  }

  if (_.isPlainObject(value)) {
    return keys.map((k) => {
      if (!(k in (value as object))) {
        throw new OrmException(`composite primary key of ${descriptor.Name} is missing column ${k}`);
      }
      // eslint-disable-next-line security/detect-object-injection
      return (value as any)[k];
    });
  }

  throw new OrmException(`composite primary key of ${descriptor.Name} needs an array in key order (${keys.join(', ')}) or an object keyed by column name, got ${typeof value}`);
}

/** Reads the primary key off a row or model: a scalar for single-column keys, a tuple for composite. */
export function pkValueOf(source: any, descriptor: IModelDescriptor): any {
  const keys = pkColumns(descriptor);

  if (keys.length === 0) {
    return undefined;
  }

  if (keys.length === 1) {
    return source?.[keys[0]];
  }

  return keys.map((k) => source?.[k]);
}

/** Writes a primary key onto a row or model. Mirror image of {@link pkValueOf}. */
export function setPkValue(target: any, descriptor: IModelDescriptor, value: any): void {
  const keys = pkColumns(descriptor);

  if (keys.length === 0) {
    return;
  }

  if (keys.length === 1) {
    target[keys[0]] = value;
    return;
  }

  const tuple = normalizePkTuple(descriptor, value);
  keys.forEach((k, i) => (target[k] = tuple[i]));
}

/**
 * Flattens the given columns of a row into one string, for use as a Map key or a lodash
 * `differenceBy` / `intersectionBy` iteratee where a tuple would compare by reference.
 * Each part is length-prefixed so `['ab', 'c']` and `['a', 'bc']` cannot collide.
 */
export function pkKeyStringFor(source: any, keys: string[]): string {
  return keys
    // eslint-disable-next-line security/detect-object-injection
    .map((k) => `${String(source?.[k]).length}:${String(source?.[k])}`)
    .join(PK_SEPARATOR);
}

/** {@link pkKeyStringFor} over a model's primary key columns. */
export function pkKeyString(source: any, descriptor: IModelDescriptor): string {
  return pkKeyStringFor(source, pkColumns(descriptor));
}

/**
 * WHERE matching exactly one row by primary key.
 * Single column: `col = ?`, byte-identical to the pre-composite behaviour.
 * Composite: `( a = ? AND b = ? )`.
 */
export function wherePk(builder: IWhereBuilder<any>, descriptor: IModelDescriptor, value: any): void {
  const keys = pkColumns(descriptor);

  if (keys.length === 0) {
    throw new OrmException(`model ${descriptor.Name} has no primary key`);
  }

  if (keys.length === 1) {
    builder.where(keys[0], Array.isArray(value) ? value[0] : value);
    return;
  }

  const tuple = normalizePkTuple(descriptor, value);
  builder.where(function (this: IWhereBuilder<any>) {
    keys.forEach((k, i) => this.where(k, tuple[i]));
  });
}

/**
 * WHERE matching any of `values`.
 * Single column: `col IN (?, ...)`.
 * Composite: `( ( a = ? AND b = ? ) OR ( a = ? AND b = ? ) )`.
 * An empty `values` matches nothing, consistent with `whereIn(col, [])` (B4b).
 */
export function whereAnyPk(builder: IWhereBuilder<any>, descriptor: IModelDescriptor, values: any[]): void {
  const keys = pkColumns(descriptor);

  if (keys.length === 0) {
    throw new OrmException(`model ${descriptor.Name} has no primary key`);
  }

  if (values.length === 0) {
    builder.where(false);
    return;
  }

  if (keys.length === 1) {
    builder.whereIn(keys[0], values.map((v) => (Array.isArray(v) ? v[0] : v)));
    return;
  }

  const tuples = values.map((v) => normalizePkTuple(descriptor, v));
  builder.where(function (this: IWhereBuilder<any>) {
    tuples.forEach((tuple, idx) => {
      const group = function (this: IWhereBuilder<any>) {
        keys.forEach((k, i) => this.where(k, tuple[i]));
      };

      if (idx === 0) {
        this.where(group);
      } else {
        this.orWhere(group);
      }
    });
  });
}

/**
 * WHERE excluding all of `values` — the orphan-delete predicate.
 * Single column: `col NOT IN (?, ...)`.
 * Composite: De Morgan of {@link whereAnyPk} — `( ( a != ? OR b != ? ) AND ( a != ? OR b != ? ) )`.
 * An empty `values` adds no condition ( nothing is excluded ).
 */
export function whereNotAnyPk(builder: IWhereBuilder<any>, descriptor: IModelDescriptor, values: any[]): void {
  const keys = pkColumns(descriptor);

  if (keys.length === 0) {
    throw new OrmException(`model ${descriptor.Name} has no primary key`);
  }

  if (values.length === 0) {
    return;
  }

  if (keys.length === 1) {
    builder.whereNotIn(keys[0], values.map((v) => (Array.isArray(v) ? v[0] : v)));
    return;
  }

  const tuples = values.map((v) => normalizePkTuple(descriptor, v));
  builder.where(function (this: IWhereBuilder<any>) {
    tuples.forEach((tuple) => {
      this.where(function (this: IWhereBuilder<any>) {
        keys.forEach((k, i) => {
          if (i === 0) {
            this.where(k, SqlOperator.NOT, tuple[i]);
          } else {
            this.orWhere(k, SqlOperator.NOT, tuple[i]);
          }
        });
      });
    });
  });
}

/**
 * Appends one ORDER BY term per primary key column. Returns false when the model has no
 * primary key, so callers can fall back to unique columns or timestamps.
 */
export function orderByPk(builder: IOrderByBuilder, descriptor: IModelDescriptor, order: SortOrder): boolean {
  const keys = pkColumns(descriptor);

  if (keys.length === 0) {
    return false;
  }

  keys.forEach((k) => builder.order(k, order));
  return true;
}

/** Generation strategy for one primary key column. Unrecorded columns default to `auto`. */
export function pkGeneration(descriptor: IModelDescriptor, column: string): PrimaryKeyGeneration {
  return descriptor.PrimaryKeyGeneration?.get(column) ?? 'auto';
}

/**
 * Fills every `uuid`-generated primary key column that has no value yet. Called immediately
 * before insert so the key is known client-side without a database round-trip. Never overwrites
 * a value the caller supplied.
 */
export function generateClientSideKeys(target: any, descriptor: IModelDescriptor): void {
  pkColumns(descriptor).forEach((c) => {
    if (pkGeneration(descriptor, c) !== 'uuid') {
      return;
    }

    // eslint-disable-next-line security/detect-object-injection
    if (target[c] === null || target[c] === undefined || target[c] === '') {
      // eslint-disable-next-line security/detect-object-injection
      target[c] = uuidv4();
    }
  });
}

/** Throws when an `assigned` primary key column has no value at insert time. */
export function assertAssignedKeys(target: any, descriptor: IModelDescriptor): void {
  pkColumns(descriptor).forEach((c) => {
    if (pkGeneration(descriptor, c) !== 'assigned') {
      return;
    }

    // eslint-disable-next-line security/detect-object-injection
    const value = target[c];
    if (value === null || value === undefined || value === '') {
      throw new OrmException(`primary key column ${descriptor.Name}.${c} must be assigned before insert (@Primary({ generated: 'assigned' }))`);
    }
  });
}
