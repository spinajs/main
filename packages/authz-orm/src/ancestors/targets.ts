import type { ResourceRef } from '@spinajs/authz';
import { insertedKeys, writeTargetKeys } from '@spinajs/orm';
import type { DeleteQueryBuilder, InsertQueryBuilder, OrmDriver, UpdateQueryBuilder } from '@spinajs/orm';

import { idLookup, idText, tableOf } from '../ids.js';
import type { ModelClass, ResourceEntry } from '../registry.js';

/** The ids an update or delete reaches, read through the ORM write capture's key select (SYSTEM under authz-orm). */
export async function targetRefs(query: UpdateQueryBuilder<unknown> | DeleteQueryBuilder<unknown>, _model: ModelClass, entry: ResourceEntry): Promise<ResourceRef[]> {
  return (await writeTargetKeys(query, entry.idColumn)).map((id) => ({ type: entry.type, id }));
}

/** Which of `refs` still have a row (a delete with a limit, or one that lost a race, reaches fewer). */
export async function stillThere(driver: OrmDriver, model: ModelClass, entry: ResourceEntry, refs: readonly ResourceRef[]): Promise<Set<string>> {
  const out = new Set<string>();
  const values = refs.map((r) => idLookup(model, entry.idColumn, String(r.id))).filter((v) => v !== undefined);
  if (values.length === 0) return out;
  const rows = (await driver.select().from(tableOf(model)).columns([entry.idColumn]).whereIn(entry.idColumn, values)) as Record<string, unknown>[];
  for (const row of rows) {
    const id = idText(row[entry.idColumn]);
    if (id !== undefined) out.add(id);
  }
  return out;
}

/** The ids an insert wrote, as the ORM's own key backfill reads them; undefined when they cannot be known. */
export function insertedRefs(query: InsertQueryBuilder, result: unknown, entry: ResourceEntry): ResourceRef[] | undefined {
  return insertedKeys(query, result, entry.idColumn)?.map((id) => ({ type: entry.type, id }));
}
