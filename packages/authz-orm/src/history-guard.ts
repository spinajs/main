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

/**
 * The relation and type columns decision replay reads of the model, when the write changes them: the row itself,
 * its key, or one of those columns. Undefined for a write that changes none.
 */
function judgedColumns({ kind, model, query }: WriteStatement): readonly string[] | undefined {
  const entry = entryOf(model);
  if (!entry || entry.changelog === false) return undefined;
  const columns = changelogColumns(entry).flatMap((c) => (c.typeColumn ? [c.column, c.typeColumn] : [c.column]));
  if (columns.length === 0) return undefined;
  if (kind !== 'update') return columns;
  const written = new Set([...Object.keys(query.Value ?? {}), ...query.Increments.keys()]);
  // The key too: row history takes an update that writes it, and replay keys a row's state by it.
  return [entry.idColumn, ...columns].some((c) => written.has(c)) ? columns : undefined;
}

const observers = (): WriteObserver[] => DI.resolve(Array.ofType(WriteObserver));

/**
 * Of the first history observer that takes the write, the columns it does not record, or the observer itself when its
 * interest has no `unrecorded` and so makes no claim; empty when one records them all, undefined when none takes it.
 * Only history observers are asked: the interest() of another may keep state for the statement it takes.
 */
function unrecordedBy(statement: WriteStatement, columns: readonly string[]): readonly string[] | WriteObserver | undefined {
  let shortfall: readonly string[] | WriteObserver | undefined;
  for (const observer of observers()) {
    const interest = observer.keepsHistory === true ? observer.interest(statement) : undefined;
    if (!interest) continue;
    const { columns: read, unrecorded } = interest;
    if (unrecorded === undefined) {
      shortfall ??= observer;
      continue;
    }
    const missing = columns.filter((c) => (read !== '*' && !read.includes(c)) || unrecorded.includes(c));
    if (missing.length === 0) return missing;
    shortfall ??= missing;
  }
  return shortfall;
}

const PHRASES: Readonly<Record<WriteStatement['kind'], string>> = { insert: 'an insert', update: 'an update', delete: 'a delete' };

// Taken only to be refused in prepare(), which the capture runs before it reads anything.
const UNRECORDED: CaptureInterest = { columns: [], transactional: false };

/**
 * With `authz.orm.requireHistory` on, refuses an insert or a delete of an `@AccessResource` model, and an update of
 * its key, relation or type columns, unless one history-keeping `WriteObserver` takes it and records every relation
 * and type column: replay would read the row's earlier relations as its state.
 */
@Injectable(WriteObserver)
export class ResourceHistoryGuard extends WriteObserver {
  public interest(statement: WriteStatement): CaptureInterest | undefined {
    const columns = judgedColumns(statement);
    if (!columns || !requireHistory()) return undefined;
    const shortfall = unrecordedBy(statement, columns);
    return shortfall !== undefined && !(shortfall instanceof WriteObserver) && shortfall.length === 0 ? undefined : UNRECORDED;
  }

  // Called only for a statement interest() took.
  public prepare(statement: WriteStatement): void {
    const type = entryOf(statement.model)?.type ?? '';
    const write = `authz-orm: ${PHRASES[statement.kind]} of ${nameOf(statement.model)} (resource '${type}')`;
    const optOut = `opt the model out with @AccessResource('${type}', { changelog: false })`;
    const shortfall = unrecordedBy(statement, judgedColumns(statement) ?? []);
    if (shortfall === undefined) {
      throw new UnrecordedResourceWrite(`${write} is not recorded by any history observer, and authz.orm.requireHistory refuses it; import @spinajs/authz-replay in this process so that it registers the model's history before the write, or ${optOut}`);
    }
    if (shortfall instanceof WriteObserver) {
      throw new UnrecordedResourceWrite(`${write} is taken by the history observer ${shortfall.constructor.name}, which does not say which columns it records, and authz.orm.requireHistory refuses it; make its interest() set unrecorded to the columns it reads but does not keep ([] when it keeps them all), or ${optOut}`);
    }
    throw new UnrecordedResourceWrite(`${write} is kept by a history observer that does not record ${shortfall.join(', ')}, and authz.orm.requireHistory refuses it; make the model's history record every relation and type column, or ${optOut}`);
  }

  public observe(): Promise<void> {
    return Promise.resolve();
  }
}
