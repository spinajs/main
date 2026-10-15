import { SYSTEM, runWithPrincipal } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { SelectQueryBuilder, createQuery } from '@spinajs/orm';
import type { DeleteQueryBuilder, IQueryStatement, InsertQueryBuilder, OrmDriver, UpdateQueryBuilder } from '@spinajs/orm';

import { idLookup, idText, tableOf } from '../ids.js';
import type { ModelClass, ResourceEntry } from '../registry.js';
import { ID_CHUNK, chunks } from './table.js';

const refsOf = (type: string, ids: readonly unknown[]): ResourceRef[] => [...new Set(ids.map((v) => idText(v)).filter((v): v is string => v !== undefined))].map((id) => ({ type, id }));

/** The ids an update or delete reaches: a select with its where statements, as SYSTEM, soft-deleted and archived rows included. */
export function targetRefs(query: UpdateQueryBuilder<unknown> | DeleteQueryBuilder<unknown>, model: ModelClass, entry: ResourceEntry): Promise<ResourceRef[]> {
  return runWithPrincipal(SYSTEM, async () => {
    const { query: select } = createQuery(model as never, SelectQueryBuilder);
    select.withDeleted().withArchived();
    const source = (query as unknown as { _statements: IQueryStatement[] })._statements;
    (select as unknown as { _statements: IQueryStatement[] })._statements = source.map((s) => {
      const c = s.clone(select as never);
      c.Boolean = s.Boolean;
      return c;
    });
    select.columns([entry.idColumn]);
    const rows = await select.asRaw<Record<string, unknown>[]>();
    return refsOf(
      entry.type,
      rows.map((r) => r[entry.idColumn]),
    );
  });
}

/** Which of `refs` still have a row (a delete with a limit, or one that lost a race, reaches fewer). */
export async function stillThere(driver: OrmDriver, model: ModelClass, entry: ResourceEntry, refs: readonly ResourceRef[]): Promise<Set<string>> {
  const out = new Set<string>();
  const values = refs.map((r) => idLookup(model, entry.idColumn, String(r.id))).filter((v) => v !== undefined);
  for (const part of chunks(values, ID_CHUNK)) {
    const rows = (await driver.select().from(tableOf(model)).columns([entry.idColumn]).whereIn(entry.idColumn, part)) as Record<string, unknown>[];
    for (const row of rows) {
      const id = idText(row[entry.idColumn]);
      if (id !== undefined) out.add(id);
    }
  }
  return out;
}

interface InsertResult {
  readonly Returning?: unknown[];
  readonly LastInsertId?: unknown;
  readonly RowsAffected?: unknown;
}

/** The ids an insert wrote, as the ORM's own key backfill reads them (model.ts:1349-1381); undefined when they cannot be known. */
export function insertedRefs(query: InsertQueryBuilder, result: unknown, entry: ResourceEntry): ResourceRef[] | undefined {
  const rows = query.Values.length;
  if (rows === 0) return [];
  const supplied = query.getColumnValues(entry.idColumn);
  if (supplied.length === rows && supplied.every((v) => v !== null && v !== undefined)) return refsOf(entry.type, supplied);
  const r: InsertResult = Array.isArray(result) ? { Returning: result } : ((result ?? {}) as InsertResult);
  const returning = Array.isArray(r.Returning) ? (r.Returning as Record<string, unknown>[]) : [];
  if (returning.length === rows && returning.every((x) => x !== null && typeof x === 'object' && x[entry.idColumn] !== undefined && x[entry.idColumn] !== null))
    return refsOf(
      entry.type,
      returning.map((x) => x[entry.idColumn]),
    );
  const last = r.LastInsertId;
  if (typeof last !== 'number' || !Number.isSafeInteger(last) || last <= 0) return undefined;
  if (rows === 1) return refsOf(entry.type, [last]);
  const noneSupplied = supplied.every((v) => v === null || v === undefined);
  if (noneSupplied && query.Driver.supportedFeatures().insertIdIsFirstOfBatch === true && r.RowsAffected === rows && !query.Ignore && !query.Replace && !query.Update) {
    return refsOf(
      entry.type,
      Array.from({ length: rows }, (_, k) => last + k),
    );
  }
  return undefined;
}
