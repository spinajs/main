import { resourceKey } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import type { IWhereBuilder, OrmDriver } from '@spinajs/orm';

import { idLookup, idText, tableOf } from '../ids.js';
import { classesOf, entryOf } from '../registry.js';
import type { Link } from './closure.js';
import { groupIds, whereRefs } from './read.js';
import { AUTHZ_RESOURCE_ANCESTOR_TABLE, ID_CHUNK, ROW_CHUNK, chunks } from './table.js';
import type { AncestorRow } from './table.js';

type Where = IWhereBuilder<unknown>;

function splitGroups(refs: readonly ResourceRef[]): Map<string, string[]>[] {
  const out: Map<string, string[]>[] = [];
  for (const [type, ids] of groupIds(refs)) for (const part of chunks(ids, ID_CHUNK)) out.push(new Map([[type, part]]));
  return out;
}

/** Every resource the table lists below one of `refs`, once. */
export async function readDescendants(driver: OrmDriver, refs: readonly ResourceRef[]): Promise<ResourceRef[]> {
  const seen = new Map<string, ResourceRef>();
  for (const groups of splitGroups(refs)) {
    const q = driver.select().from(AUTHZ_RESOURCE_ANCESTOR_TABLE).columns(['resource_type', 'resource_id']);
    whereRefs(q as unknown as Where, 'ancestor_type', 'ancestor_id', groups);
    for (const row of (await q) as Record<string, unknown>[]) {
      const ref = { type: String(row.resource_type), id: String(row.resource_id) };
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
      const columns = [entry.idColumn, ...new Set(entry.parents.map((p) => p.column))];
      const values = ids
        .filter((id) => !out.has(resourceKey({ type, id })))
        .map((id) => idLookup(cls, entry.idColumn, id))
        .filter((v) => v !== undefined);
      for (const part of chunks(values, ID_CHUNK)) {
        if (part.length === 0) continue;
        const rows = (await driver.select().from(table).columns(columns).whereIn(entry.idColumn, part)) as Record<string, unknown>[];
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
  }
  return out;
}

/** Deletes the rows whose resource is one of `refs`. */
export async function deleteRowsOf(driver: OrmDriver, refs: readonly ResourceRef[]): Promise<void> {
  for (const groups of splitGroups(refs)) {
    const q = driver.del().from(AUTHZ_RESOURCE_ANCESTOR_TABLE);
    whereRefs(q as unknown as Where, 'resource_type', 'resource_id', groups);
    await q;
  }
}

/** Replaces the rows of `nodes` with `closure` (nodes without an entry get none). */
export async function replaceAncestors(driver: OrmDriver, nodes: readonly ResourceRef[], closure: ReadonlyMap<string, readonly Link[]>): Promise<void> {
  await deleteRowsOf(driver, nodes);
  const rows: AncestorRow[] = [];
  for (const n of nodes) {
    for (const l of closure.get(resourceKey(n)) ?? []) rows.push({ resource_type: n.type, resource_id: String(n.id), ancestor_type: l.type, ancestor_id: l.id, depth: l.depth });
  }
  for (const part of chunks(rows, ROW_CHUNK)) await driver.insert().into(AUTHZ_RESOURCE_ANCESTOR_TABLE).values(part);
}
