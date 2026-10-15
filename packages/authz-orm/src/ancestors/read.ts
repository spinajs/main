import { resourceKey } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import type { IWhereBuilder, OrmDriver } from '@spinajs/orm';

import { ANCESTOR_COLUMNS, AUTHZ_RESOURCE_ANCESTOR_TABLE, ID_CHUNK, chunks } from './table.js';
import type { AncestorRow } from './table.js';

type Where = IWhereBuilder<unknown>;

/** Ids of the refs that have one, by type. */
export function groupIds(refs: readonly ResourceRef[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of refs) {
    if (r.id === undefined || r.id === null) continue;
    const ids = out.get(r.type) ?? [];
    if (!ids.includes(String(r.id))) ids.push(String(r.id));
    out.set(r.type, ids);
  }
  return out;
}

/** `(typeColumn = t1 AND idColumn IN (…)) OR (typeColumn = t2 AND …)` as one where group. */
export function whereRefs(q: Where, typeColumn: string, idColumn: string, groups: ReadonlyMap<string, readonly string[]>): void {
  q.where(function (this: Where) {
    let first = true;
    for (const [type, ids] of groups) {
      const clause = function (this: Where) {
        this.where(typeColumn, type).whereIn(idColumn, [...ids]);
      };
      if (first) this.where(clause as never);
      else this.orWhere(clause as never);
      first = false;
    }
  } as never);
}

export const byDepth = (a: AncestorRow, b: AncestorRow): number => a.depth - b.depth || (a.ancestor_type < b.ancestor_type ? -1 : a.ancestor_type > b.ancestor_type ? 1 : 0) || (a.ancestor_id < b.ancestor_id ? -1 : a.ancestor_id > b.ancestor_id ? 1 : 0);

function split(refs: readonly ResourceRef[]): Map<string, string[]>[] {
  const out: Map<string, string[]>[] = [];
  for (const [type, ids] of groupIds(refs)) for (const part of chunks(ids, ID_CHUNK)) out.push(new Map([[type, part]]));
  return out;
}

/** The table rows of each ref (as resource), by resourceKey, nearest first. */
export async function readAncestors(driver: OrmDriver, refs: readonly ResourceRef[]): Promise<Map<string, AncestorRow[]>> {
  const out = new Map<string, AncestorRow[]>();
  for (const groups of split(refs)) {
    const q = driver
      .select()
      .from(AUTHZ_RESOURCE_ANCESTOR_TABLE)
      .columns([...ANCESTOR_COLUMNS]);
    whereRefs(q as unknown as Where, 'resource_type', 'resource_id', groups);
    for (const raw of (await q) as Record<string, unknown>[]) {
      const row: AncestorRow = { resource_type: String(raw.resource_type), resource_id: String(raw.resource_id), ancestor_type: String(raw.ancestor_type), ancestor_id: String(raw.ancestor_id), depth: Number(raw.depth) };
      const key = resourceKey({ type: row.resource_type, id: row.resource_id });
      const list = out.get(key) ?? [];
      list.push(row);
      out.set(key, list);
    }
  }
  for (const list of out.values()) list.sort(byDepth);
  return out;
}
