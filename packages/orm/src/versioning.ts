import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { OptimisticLockError } from './exceptions.js';
import { InsertBehaviour } from './interfaces.js';
import type { IModelDescriptor, IWhereBuilder } from './interfaces.js';
import type { ModelBase } from './model.js';
import { pkColumns, pkGeneration } from './primary-keys.js';
import { createSnapshot } from './snapshot.js';

/** The version a model was read at and the one its write sets. NULL is the version of a row written before the column existed. */
export interface VersionLock {
  column: string;
  expected: number | null;
  next: number;
}

// pg returns bigint as a string, and a version sent back by a client may arrive as one
function versionValue(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : null;
  }

  return typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

export function versionLock(model: ModelBase): VersionLock | null {
  const column = model.ModelDescriptor?.VersionColumn;
  if (!column) {
    return null;
  }

  const expected = versionValue(Reflect.get(model, column));
  return { column, expected, next: (expected ?? 0) + 1 };
}

/** A new row starts at version 1. Returns the undo for an insert that fails. */
export function startVersion(model: ModelBase): () => void {
  const column = model.ModelDescriptor?.VersionColumn;
  if (!column) {
    return () => undefined;
  }

  const previous: unknown = Reflect.get(model, column);
  Reflect.set(model, column, 1);
  return () => Reflect.set(model, column, previous);
}

/** The static `Model.insert()`: a model starts at version 1, a plain object keeps a version it supplies. */
export function startVersionOf(descriptor: IModelDescriptor, data: object, isModel: boolean): void {
  const column = descriptor.VersionColumn;
  if (column && (isModel || Reflect.get(data, column) === null || Reflect.get(data, column) === undefined)) {
    Reflect.set(data, column, 1);
  }
}

/** A replace deletes the row and inserts a new one, which would restart its version. */
export function refuseReplace(descriptor: IModelDescriptor, behaviour: InsertBehaviour): void {
  if (descriptor.VersionColumn && behaviour === InsertBehaviour.InsertOrReplace) {
    throw new InvalidOperation(`${descriptor.Name} is versioned with @Version; InsertOrReplace would restart the version of an existing row`);
  }
}

/** The version column a bulk update increments; a version in its data would set every matched row to one value. */
export function bulkVersionColumn(descriptor: IModelDescriptor, values: Record<string, unknown>): string | undefined {
  const column = descriptor.VersionColumn;
  if (column && Object.prototype.hasOwnProperty.call(values, column)) {
    throw new InvalidArgument(`${descriptor.Name}.${column} is the @Version column; a bulk update increments it and cannot set it. To repair versions, use driver.update()`);
  }

  return column;
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

// A persisted model: its columns and baseline (a reload rebases both in place). A new one: its version and generated keys.
function writtenColumns(model: ModelBase): string[] {
  const descriptor = model.ModelDescriptor;
  if (model.Snapshot) {
    return [...model.Snapshot.Columns.keys()];
  }

  const keys = descriptor ? pkColumns(descriptor).filter((c) => pkGeneration(descriptor, c) === 'auto') : [];
  return descriptor?.VersionColumn ? [...keys, descriptor.VersionColumn] : keys;
}

/** What a rolled-back `save()` must put back on its models (column values, versions, keys, diff baselines), so a retry writes the same edits. */
export function captureWriteState(models: ModelBase[]): () => void {
  const saved = models.map((model) => {
    const snapshot = model.Snapshot ? Object.assign(createSnapshot(), { Columns: new Map(model.Snapshot.Columns), Relations: new Map(model.Snapshot.Relations) }) : null;
    return { model, snapshot, values: writtenColumns(model).map((c): [string, unknown] => [c, Reflect.get(model, c)]) };
  });

  return () => {
    for (const { model, snapshot, values } of saved) {
      // `__snapshot__` is private to ModelBase; a rollback is the one place an older baseline comes back
      Reflect.set(model, '__snapshot__', snapshot);
      values.forEach(([column, value]) => Reflect.set(model, column, value));
    }
  };
}
