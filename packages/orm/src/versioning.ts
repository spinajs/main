import { OptimisticLockError } from './exceptions.js';
import type { IModelDescriptor, IWhereBuilder } from './interfaces.js';
import type { ModelBase } from './model.js';

/** The version a model was read at and the one its write sets. NULL is the version of a row written before the column existed. */
export interface VersionLock {
  column: string;
  expected: number | null;
  next: number;
}

export function versionLock(model: ModelBase): VersionLock | null {
  const column = model.ModelDescriptor?.VersionColumn;
  if (!column) {
    return null;
  }

  const value: unknown = Reflect.get(model, column);
  const expected = typeof value === 'number' ? value : null;
  return { column, expected, next: (expected ?? 0) + 1 };
}

/** A new row starts at version 1. */
export function startVersion(model: ModelBase): void {
  const column = model.ModelDescriptor?.VersionColumn;
  if (column) {
    Reflect.set(model, column, 1);
  }
}

/** The static `Model.insert()` writes models and plain objects alike; both start at version 1. */
export function startVersionOf(descriptor: IModelDescriptor, data: object): void {
  if (descriptor.VersionColumn) {
    Reflect.set(data, descriptor.VersionColumn, 1);
  }
}

export function withVersion(lock: VersionLock | null, payload: Record<string, unknown>): Record<string, unknown> {
  return lock ? { ...payload, [lock.column]: lock.next } : payload;
}

export function whereVersion(lock: VersionLock | null, query: IWhereBuilder<unknown>): void {
  if (lock) {
    query.where(lock.column, lock.expected);
  }
}

/** Throws when the versioned statement matched no row; otherwise moves the model to the version it wrote. */
export function settleVersion(lock: VersionLock | null, result: unknown, model: ModelBase): void {
  if (!lock) {
    return;
  }

  // not sql-helpers' rowsAffected: that module imports the builders, and this one is imported by model.ts
  const affected = (result as { RowsAffected?: unknown } | null | undefined)?.RowsAffected;
  if (typeof affected !== 'number' || affected === 0) {
    throw new OptimisticLockError(model.constructor.name, model.PrimaryKeyValue, lock.expected);
  }

  Reflect.set(model, lock.column, lock.next);
}
