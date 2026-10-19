import { resourceKey } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { deleteFrom } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { idLookup, idText, tableOf } from '../ids.js';
import { selectFrom } from '../records.js';
import { classesOf, entryOf } from '../registry.js';
import type { Link } from './closure.js';
import { groupIds } from './read.js';
import { AncestorRecord } from './record.js';
import type { AncestorRow } from './table.js';

/** Every resource the table lists below one of `refs`, once. */
export async function readDescendants(refs: readonly ResourceRef[]): Promise<ResourceRef[]> {
  const seen = new Map<string, ResourceRef>();
  for (const [type, ids] of groupIds(refs)) {
    for (const row of await selectFrom(AncestorRecord).columns(['resource_type', 'resource_id']).where('ancestor_type', type).whereIn('ancestor_id', ids)) {
      const ref = { type: row.resource_type, id: row.resource_id };
      seen.set(resourceKey(ref), ref);
    }
  }
  return [...seen.values()];
}

/**
 * The direct parents of each ref, read from its model's `@Parent` columns through `driver` (the
 * statement's transaction). A ref whose row no class of its type has gets no parents: it becomes a root.
 */
export async function readParents(driver: OrmDriver, refs: readonly ResourceRef[]): Promise<Map<string, ResourceRef[]>> {
  const out = new Map<string, ResourceRef[]>();
  for (const [type, ids] of groupIds(refs)) {
    const tables = new Set<string>();
    for (const cls of classesOf(type)) {
      const entry = entryOf(cls)!;
      const table = tableOf(cls);
      if (entry.parents.length === 0 || tables.has(table)) continue;
      tables.add(table);
      const values = ids
        .filter((id) => !out.has(resourceKey({ type, id })))
        .map((id) => idLookup(cls, entry.idColumn, id))
        .filter((v) => v !== undefined);
      if (values.length === 0) continue;
      const columns = [entry.idColumn, ...new Set(entry.parents.map((p) => p.column))];
      const rows = (await driver.select().from(table).columns(columns).whereIn(entry.idColumn, values)) as Record<string, unknown>[];
      for (const row of rows) {
        const id = idText(row[entry.idColumn]);
        if (id === undefined) continue;
        const list: ResourceRef[] = [];
        for (const p of entry.parents) {
          const parentId = idText(row[p.column]);
          if (parentId !== undefined) list.push({ type: p.type, id: parentId });
        }
        out.set(resourceKey({ type, id }), list);
      }
    }
  }
  return out;
}

/** Deletes the rows whose resource is one of `refs`. */
export async function deleteRowsOf(refs: readonly ResourceRef[]): Promise<void> {
  for (const [type, ids] of groupIds(refs)) await deleteFrom(AncestorRecord).where('resource_type', type).whereIn('resource_id', ids);
}

/** Replaces the rows of `nodes` with `closure` (nodes without an entry get none). */
export async function replaceAncestors(nodes: readonly ResourceRef[], closure: ReadonlyMap<string, readonly Link[]>): Promise<void> {
  await deleteRowsOf(nodes);
  const rows: AncestorRow[] = [];
  for (const n of nodes) {
    for (const l of closure.get(resourceKey(n)) ?? []) rows.push({ resource_type: n.type, resource_id: String(n.id), ancestor_type: l.type, ancestor_id: l.id, depth: l.depth });
  }
  if (rows.length > 0) await AncestorRecord.insert(rows);
}
