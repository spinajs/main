import { resourceKey } from '@spinajs/authz';
import type { ResourceRef, ResourceType } from '@spinajs/authz';
import type { OrmDriver } from '@spinajs/orm';

import { idLookup, idText, tableOf } from '../ids.js';
import { selectFrom } from '../records.js';
import { classesOf, entryOf, registeredTypes } from '../registry.js';
import type { ModelClass } from '../registry.js';
import type { Link } from './closure.js';
import { groupIds } from './read.js';
import { AncestorRecord } from './record.js';
import type { AncestorRow } from './table.js';

/** Every resource the table lists below one of `refs`, once. */
export async function readDescendants(refs: readonly ResourceRef[]): Promise<ResourceRef[]> {
  const seen = new Map<string, ResourceRef>();
  // spinajs-orm-ignore ORM102: one whereIn query per resource type in refs
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
    // spinajs-orm-ignore ORM102: one whereIn query per distinct class table of the type
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

/** The keys of `refs` that have a row in a class table of their type, read through `driver`, soft-deleted and archived rows included. */
export async function readExisting(driver: OrmDriver, refs: readonly ResourceRef[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const [type, ids] of groupIds(refs)) {
    const tables = new Set<string>();
    // spinajs-orm-ignore ORM102: one whereIn query per distinct class table of the type
    for (const cls of classesOf(type)) {
      const entry = entryOf(cls);
      const table = tableOf(cls);
      if (entry === undefined || tables.has(table)) continue;
      tables.add(table);
      const values = ids
        .filter((id) => !out.has(resourceKey({ type, id })))
        .map((id) => idLookup(cls, entry.idColumn, id))
        .filter((v) => v !== undefined);
      if (values.length === 0) continue;
      for (const row of (await driver.select().from(table).columns([entry.idColumn]).whereIn(entry.idColumn, values)) as Record<string, unknown>[]) {
        const id = idText(row[entry.idColumn]);
        if (id !== undefined) out.add(resourceKey({ type, id }));
      }
    }
  }
  return out;
}

/** Deletes the rows whose resource is one of `refs`. */
export async function deleteRowsOf(refs: readonly ResourceRef[]): Promise<void> {
  for (const [type, ids] of groupIds(refs)) await AncestorRecord.destroy().where('resource_type', type).whereIn('resource_id', ids);
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

/** The resources whose `@Parent` column names one of `refs`, read from their class tables through `driver`. */
export async function readChildrenNaming(driver: OrmDriver, refs: readonly ResourceRef[]): Promise<ResourceRef[]> {
  const out = new Map<string, ResourceRef>();
  for (const [type, ids] of groupIds(refs)) {
    for (const childType of registeredTypes()) {
      const read = new Set<string>();
      // spinajs-orm-ignore ORM102: one whereIn query per class table and parent column that names the type
      for (const cls of classesOf(childType)) {
        for (const id of await readChildIds(driver, cls, type, ids, read)) out.set(resourceKey({ type: childType, id }), { type: childType, id });
      }
    }
  }
  return [...out.values()];
}

/** The ids of the rows of `cls` whose `@Parent` columns of `type` name one of `ids`; a table column in `read` is not read again. */
async function readChildIds(driver: OrmDriver, cls: ModelClass, type: ResourceType, ids: readonly string[], read: Set<string>): Promise<string[]> {
  const entry = entryOf(cls);
  if (entry === undefined) return [];
  const found: string[] = [];
  // spinajs-orm-ignore ORM102: one whereIn query per parent column that names the type
  for (const column of new Set(entry.parents.filter((p) => p.type === type).map((p) => p.column))) {
    const at = `${tableOf(cls)}.${column}`;
    const values = ids.map((id) => idLookup(cls, column, id)).filter((v) => v !== undefined);
    if (read.has(at) || values.length === 0) continue;
    read.add(at);
    const rows = (await driver.select().from(tableOf(cls)).columns([entry.idColumn]).whereIn(column, values)) as Record<string, unknown>[];
    for (const row of rows) {
      const id = idText(row[entry.idColumn]);
      if (id !== undefined) found.push(id);
    }
  }
  return found;
}
