import { AuthzConfigError } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { DeleteQueryBuilder, InsertQueryBuilder, QueryMiddleware, TruncateTableQueryBuilder, UpdateQueryBuilder, WriteObserver, extractModelDescriptor } from '@spinajs/orm';
import type { CaptureInterest, QueryBuilder, WriteStatement } from '@spinajs/orm';

import { changelogColumns, entryOf, nameOf, registeredClasses } from './registry.js';
import type { ResourceEntry } from './registry.js';

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
 * The relation and type columns decision replay reads of a resource, when the write changes them: the row itself, its
 * key, or one of those columns. `written` holds an update's columns, undefined for any other write; the result is
 * undefined for a write that changes none.
 */
function judged(entry: ResourceEntry, written: ReadonlySet<string> | undefined): readonly string[] | undefined {
  if (entry.changelog === false) return undefined;
  const columns = changelogColumns(entry).flatMap((c) => (c.typeColumn ? [c.column, c.typeColumn] : [c.column]));
  if (columns.length === 0) return undefined;
  if (written === undefined) return columns;
  // The key too: row history takes an update that writes it, and replay keys a row's state by it.
  return [entry.idColumn, ...columns].some((c) => written.has(c)) ? columns : undefined;
}

const writtenBy = (query: UpdateQueryBuilder<unknown>): ReadonlySet<string> => new Set([...Object.keys(query.Value ?? {}), ...query.Increments.keys()]);

function judgedColumns({ kind, model, query }: WriteStatement): readonly string[] | undefined {
  const entry = entryOf(model);
  if (!entry) return undefined;
  if (kind === 'update') return judged(entry, writtenBy(query));
  return judged(entry, undefined);
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

const PAST = { insert: 'an insert', update: 'an update', delete: 'a delete', truncate: 'a truncate' } as const;

function writeKind(query: QueryBuilder): keyof typeof PAST | undefined {
  if (query instanceof InsertQueryBuilder) return 'insert';
  if (query instanceof UpdateQueryBuilder) return 'update';
  if (query instanceof DeleteQueryBuilder) return 'delete';
  if (query instanceof TruncateTableQueryBuilder) return 'truncate';
  return undefined;
}

/**
 * With `authz.orm.requireHistory` on, refuses a judged write of a resource table that does not go through the table's
 * own model: the capture hands it to no `WriteObserver`, so no history records it. Raw SQL stays the one way out.
 */
@Injectable(QueryMiddleware)
export class PastModelResourceWriteGuard extends QueryMiddleware {
  public afterQueryCreation(_query: QueryBuilder): void {}

  public beforeQueryExecution(query: QueryBuilder): void {
    const kind = writeKind(query);
    if (kind === undefined) return;
    if (query.Model !== undefined && extractModelDescriptor(query.Model)?.TableName === query.Table) return;
    const written = query instanceof UpdateQueryBuilder ? writtenBy(query) : undefined;
    for (const model of registeredClasses()) {
      if (extractModelDescriptor(model)?.TableName !== query.Table) continue;
      const entry = entryOf(model);
      const columns = entry ? judged(entry, written) : undefined;
      if (!entry || !columns) continue;
      if (!requireHistory()) return;
      throw new UnrecordedResourceWrite(
        `authz-orm: ${PAST[kind]} of ${query.Table} (resource '${entry.type}') goes past its model ${nameOf(model)}, so no history observer records ${columns.join(', ')}, and authz.orm.requireHistory refuses it; write it through the model in a process that imports @spinajs/authz-replay, or with raw SQL where it must not be recorded`,
      );
    }
  }
}
