import { AuthzConfigError } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { WriteObserver } from '@spinajs/orm';
import type { CaptureInterest, WriteStatement } from '@spinajs/orm';

import { changelogColumns, entryOf, nameOf } from './registry.js';

/** A write of an `@AccessResource` model that no history observer records, refused under `authz.orm.requireHistory`. */
export class UnrecordedResourceWrite extends AuthzConfigError {}

/** `authz.orm.requireHistory`. Only an unset key reads as off: a value of another type the schema did not check must not. */
export function historyRequired(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new AuthzConfigError('authz-orm: authz.orm.requireHistory must be a boolean');
  return value;
}

const requireHistory = (): boolean => historyRequired(DI.get(Configuration)?.get<unknown>(['authz', 'orm', 'requireHistory']));

/** Whether the write changes what decision replay reads of a resource row: the row itself, its key, or a relation or type column. */
function changesRelations({ kind, model, query }: WriteStatement): boolean {
  const entry = entryOf(model);
  if (!entry || entry.changelog === false) return false;
  const columns = changelogColumns(entry).flatMap((c) => (c.typeColumn ? [c.column, c.typeColumn] : [c.column]));
  if (columns.length === 0) return false;
  if (kind === 'update') {
    const written = new Set([...Object.keys(query.Value ?? {}), ...query.Increments.keys()]);
    // The key too: row history takes an update that writes it, and replay keys a row's state by it.
    return [entry.idColumn, ...columns].some((c) => written.has(c));
  }
  return true;
}

const observers = (): WriteObserver[] => DI.resolve(Array.ofType(WriteObserver));

// Only history observers are asked: the interest() of another observer may keep state for the statement it takes.
const recordedByHistory = (statement: WriteStatement): boolean => observers().some((o) => o.keepsHistory === true && o.interest(statement) !== undefined);

const PHRASES: Readonly<Record<WriteStatement['kind'], string>> = { insert: 'an insert', update: 'an update', delete: 'a delete' };

// Taken only to be refused in prepare(), which the capture runs before it reads anything.
const UNRECORDED: CaptureInterest = { columns: [], transactional: false };

/**
 * With `authz.orm.requireHistory` on, refuses a write of an `@AccessResource` model's relation columns that no
 * history-keeping `WriteObserver` takes: replay would read the row's earlier relations as its state.
 */
@Injectable(WriteObserver)
export class ResourceHistoryGuard extends WriteObserver {
  public interest(statement: WriteStatement): CaptureInterest | undefined {
    return changesRelations(statement) && requireHistory() && !recordedByHistory(statement) ? UNRECORDED : undefined;
  }

  // Called only for a statement interest() took.
  public prepare(statement: WriteStatement): void {
    const type = entryOf(statement.model)?.type ?? '';
    throw new UnrecordedResourceWrite(
      `authz-orm: ${PHRASES[statement.kind]} of ${nameOf(statement.model)} (resource '${type}') is not recorded by any history observer, and authz.orm.requireHistory refuses it; import @spinajs/authz-replay in this process so that it registers the model's history before the write, or opt the model out with @AccessResource('${type}', { changelog: false })`,
    );
  }

  public observe(): Promise<void> {
    return Promise.resolve();
  }
}
