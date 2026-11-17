import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';

import { SelectQueryBuilder, createQuery } from '../builders.js';
import type { DeleteQueryBuilder, InsertQueryBuilder, UpdateQueryBuilder } from '../builders.js';
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

const uniqueKeys = (values: readonly unknown[]): string[] => [...new Set(values.map(captureKeyText).filter((v): v is string => v !== undefined))];

const isRow = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** The keys an update or delete reaches: a select with its where statements, soft-deleted and archived rows included. */
export async function writeTargetKeys(query: UpdateQueryBuilder<unknown> | DeleteQueryBuilder<unknown>, pk: string): Promise<string[]> {
  const model = query.Model;
  if (!model) throw new InvalidArgument('write capture: the keys of a write are read through its model, and this query has none');
  return captureReadScope().run(async () => {
    const { query: select } = createQuery(model, SelectQueryBuilder);
    // A model select may be routed to a replica; the rows a write is about to change are read where it runs.
    select.withDeleted().withArchived().onPrimary();
    const clones = query.Statements.map((s) => {
      const c = s.clone(select);
      c.Boolean = s.Boolean;
      return c;
    });
    select.Statements.splice(0, select.Statements.length, ...clones);
    select.columns([pk]);
    const rows = await select.asRaw<Record<string, unknown>[]>();
    return uniqueKeys(rows.map((r) => r[pk]));
  });
}

/** The keys an upsert may overwrite: the supplied ones. A plain insert overwrites none. */
export function upsertKeys(query: InsertQueryBuilder, pk: string): string[] {
  if (query.Ignore !== true && !query.Replace && !query.Update) return [];
  return uniqueKeys(query.getColumnValues(pk));
}

interface InsertResult {
  readonly Returning?: unknown;
  readonly LastInsertId?: unknown;
  readonly RowsAffected?: unknown;
}

function insertResultOf(result: unknown): InsertResult {
  if (Array.isArray(result)) return { Returning: result };
  return isRow(result) ? result : {};
}

/** The keys an insert wrote, read the way ModelBase.insert backfills them; undefined when they cannot be known. */
export function insertedKeys(query: InsertQueryBuilder, result: unknown, pk: string): string[] | undefined {
  const rows = query.Values.length;
  if (rows === 0) return [];
  const supplied = query.getColumnValues(pk);
  if (supplied.length === rows && supplied.every((v) => v !== null && v !== undefined)) return uniqueKeys(supplied);
  const r = insertResultOf(result);
  const returning = Array.isArray(r.Returning) ? r.Returning.filter(isRow) : [];
  if (returning.length === rows && returning.every((x) => x[pk] !== undefined && x[pk] !== null)) return uniqueKeys(returning.map((x) => x[pk]));
  return keysFromLastInsertId(query, r, supplied);
}

function keysFromLastInsertId(query: InsertQueryBuilder, r: InsertResult, supplied: readonly unknown[]): string[] | undefined {
  const rows = query.Values.length;
  const last = r.LastInsertId;
  if (typeof last !== 'number' || !Number.isSafeInteger(last) || last <= 0) return undefined;
  if (rows === 1) return [String(last)];
  const noneSupplied = supplied.every((v) => v === null || v === undefined);
  if (noneSupplied && query.Driver.supportedFeatures().insertIdIsFirstOfBatch === true && r.RowsAffected === rows && !query.Ignore && !query.Replace && !query.Update) {
    return Array.from({ length: rows }, (_, k) => String(last + k));
  }
  return undefined;
}
