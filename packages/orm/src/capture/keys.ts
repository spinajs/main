import { isDeepStrictEqual } from 'node:util';

import { DI } from '@spinajs/di';
import { InvalidArgument, NotSupported } from '@spinajs/exceptions';

import { SelectQueryBuilder, createQuery } from '../builders.js';
import type { DeleteQueryBuilder, InsertQueryBuilder, UpdateQueryBuilder } from '../builders.js';
import type { OrmDriver } from '../driver.js';
import { SqlExpressions } from '../expressions.js';
import { ServerResponseMapper } from '../interfaces.js';
import { CaptureReadScope } from './contracts.js';

class DirectCaptureReadScope extends CaptureReadScope {
  run<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

const DIRECT = new DirectCaptureReadScope();

export function captureReadScope(): CaptureReadScope {
  return DI.RootContainer.hasRegistered(CaptureReadScope) ? DI.resolve(CaptureReadScope) : DIRECT;
}

/** A primary key value as text; undefined for a value no row key can have. */
export function captureKeyText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : undefined;
  if (typeof value === 'bigint') return value.toString();
  return undefined;
}

/** Key values as their distinct texts, and the values among them that have no text. */
export interface KeyTexts {
  readonly keys: string[];
  readonly keyless: unknown[];
}

export const noKeys = (): KeyTexts => ({ keys: [], keyless: [] });

export function keyTexts(values: readonly unknown[]): KeyTexts {
  const keys = new Set<string>();
  const keyless: unknown[] = [];
  for (const value of values) {
    const key = captureKeyText(value);
    if (key === undefined) keyless.push(value);
    else keys.add(key);
  }
  return { keys: [...keys], keyless };
}

/** Tells keyless values apart without comparing them pairwise; not a key text, so it never reaches `rows`. */
export function keylessIdentity(value: unknown): string | undefined {
  if (Buffer.isBuffer(value)) return `b:${value.toString('hex')}`;
  if (value instanceof Uint8Array) return `u:${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex')}`;
  if (value instanceof Date) return `d:${String(value.getTime())}`;
  if (typeof value === 'number') return `n:${String(value)}`;
  return undefined;
}

/**
 * The rows behind the keyless key values of several reads of one statement. One read meets a row once, so values are
 * matched only with those of earlier reads.
 */
export function countKeyless(reads: readonly (readonly unknown[])[]): number {
  const identities = new Set<string>();
  const others: unknown[] = [];
  let count = 0;
  for (const values of reads) {
    const fresh = values.map((value) => ({ value, identity: keylessIdentity(value) })).filter(({ value, identity }) => (identity === undefined ? !others.some((o) => isDeepStrictEqual(o, value)) : !identities.has(identity)));
    for (const { value, identity } of fresh) {
      if (identity === undefined) others.push(value);
      else identities.add(identity);
    }
    count += fresh.length;
  }
  return count;
}

const uniqueKeys = (values: readonly unknown[]): string[] => keyTexts(values).keys;

/** The value of a column whose name is only known at run time. */
export const columnValue = (row: Readonly<Record<string, unknown>>, column: string): unknown => Reflect.get(row, column);

/**
 * Whether a select on `driver` may call `forUpdate()` and `forShare()`. A dialect without a row lock clause (MSSQL)
 * throws NotSupported from `rowLock()`; SQLite answers '' as its writes lock the database.
 */
export function supportsRowLocks(driver: OrmDriver): boolean {
  const expressions = driver.Container.resolve(SqlExpressions);
  try {
    expressions.rowLock('update');
    expressions.rowLock('share');
    return true;
  } catch (e) {
    if (e instanceof NotSupported) return false;
    throw e;
  }
}

/** Inside a transaction, the capture's reads of an update or delete lock what they read. */
export const lockedReads = (driver: OrmDriver): boolean => driver.CurrentTransaction !== undefined && supportsRowLocks(driver);

/**
 * The keys an update or delete reaches: a select with its where statements, soft-deleted and archived rows included.
 * Inside a transaction it locks those rows, so they keep the values the capture reads until the statement ran. With
 * `limit`, at most that many keys are read.
 */
export async function writeTargetKeys(query: UpdateQueryBuilder<unknown> | DeleteQueryBuilder<unknown>, pk: string, limit?: number): Promise<string[]> {
  return (await writeTargetKeyTexts(query, pk, limit)).keys;
}

export async function writeTargetKeyTexts(query: UpdateQueryBuilder<unknown> | DeleteQueryBuilder<unknown>, pk: string, limit?: number): Promise<KeyTexts> {
  const model = query.Model;
  if (!model) throw new InvalidArgument('write capture: the keys of a write are read through its model, and this query has none');
  return captureReadScope().run(async () => {
    const { query: select } = createQuery(model, SelectQueryBuilder);
    // A model select may be routed to a replica; the rows a write is about to change are read where it runs.
    select.withDeleted().withArchived().onPrimary();
    if (lockedReads(query.Driver)) select.forUpdate();
    const clones = query.Statements.map((s) => {
      const c = s.clone(select);
      c.Boolean = s.Boolean;
      return c;
    });
    select.Statements.splice(0, select.Statements.length, ...clones);
    select.columns([pk]);
    if (limit !== undefined) select.take(limit);
    const rows = await select.asRaw<Record<string, unknown>[]>();
    return keyTexts(rows.map((r) => columnValue(r, pk)));
  });
}

/** The keys an upsert may overwrite: the supplied ones. A plain insert overwrites none. */
export function upsertKeys(query: InsertQueryBuilder, pk: string): string[] {
  if (query.Ignore !== true && !query.Replace && !query.Update) return [];
  return uniqueKeys(query.getColumnValues(pk));
}

/** The keys an insert wrote: the supplied ones, else what the connection's `ServerResponseMapper.insertedKeys` reports. */
export function insertedKeys(query: InsertQueryBuilder, result: unknown, pk: string): string[] | undefined {
  return insertedKeyTexts(query, result, pk)?.keys;
}

export function insertedKeyTexts(query: InsertQueryBuilder, result: unknown, pk: string): KeyTexts | undefined {
  const rows = query.Values.length;
  if (rows === 0) return noKeys();
  const supplied = query.getColumnValues(pk);
  if (supplied.length === rows && supplied.every((v) => v !== null && v !== undefined)) return keyTexts(supplied);
  const keys = query.Container.resolve(ServerResponseMapper).insertedKeys(result, query);
  return keys && keyTexts(keys.map((k) => columnValue(k, pk)));
}
