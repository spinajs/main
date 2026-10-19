import { resourceKey } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';

import { selectFrom } from '../records.js';
import { AncestorRecord } from './record.js';
import type { AncestorRow } from './table.js';

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

export const byDepth = (a: AncestorRow, b: AncestorRow): number => a.depth - b.depth || (a.ancestor_type < b.ancestor_type ? -1 : a.ancestor_type > b.ancestor_type ? 1 : 0) || (a.ancestor_id < b.ancestor_id ? -1 : a.ancestor_id > b.ancestor_id ? 1 : 0);

/** The table rows of each ref (as resource), by resourceKey, nearest first. */
export async function readAncestors(refs: readonly ResourceRef[]): Promise<Map<string, AncestorRow[]>> {
  const out = new Map<string, AncestorRow[]>();
  for (const [type, ids] of groupIds(refs)) {
    for (const row of await selectFrom(AncestorRecord).where('resource_type', type).whereIn('resource_id', ids)) {
      const key = resourceKey({ type: row.resource_type, id: row.resource_id });
      const list = out.get(key) ?? [];
      list.push(row);
      out.set(key, list);
    }
  }
  for (const list of out.values()) list.sort(byDepth);
  return out;
}
