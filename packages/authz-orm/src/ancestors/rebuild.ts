import { AuthzConfigError, resourceKey } from '@spinajs/authz';
import type { ResourceRef, ResourceType } from '@spinajs/authz';
import type { OrmDriver } from '@spinajs/orm';

import { closeOver } from './closure.js';
import type { Link } from './closure.js';
import { undeclaredAncestorTypes, undeclaredLinks } from './full.js';
import { readAncestors } from './read.js';
import { deleteRowsOf, readDescendants, readParents, replaceAncestors } from './store.js';
import type { AncestorRow } from './table.js';

function unique(refs: readonly ResourceRef[], skip: ReadonlySet<string> = new Set()): ResourceRef[] {
  const out = new Map<string, ResourceRef>();
  for (const r of refs) {
    const k = resourceKey(r);
    if (!skip.has(k) && r.id !== undefined && r.id !== null) out.set(k, { type: r.type, id: String(r.id) });
  }
  return [...out.values()];
}

/** Recomputes `nodes` from their `@Parent` columns; parents outside `nodes` contribute their table rows. */
export async function rebuildNodes(driver: OrmDriver, nodes: readonly ResourceRef[], gone: ReadonlySet<string> = new Set()): Promise<number> {
  const list = unique(nodes, gone);
  if (list.length === 0) return 0;
  const keys = new Set(list.map((n) => resourceKey(n)));
  const parents = await readParents(driver, list);
  const outsideRefs = unique([...parents.values()].flat(), new Set([...keys, ...gone]));
  const rows = await readAncestors([...list, ...outsideRefs]);
  refuseToDropUndeclared(list, rows);
  const outside = new Map<string, Link[]>();
  for (const ref of outsideRefs) outside.set(resourceKey(ref), (rows.get(resourceKey(ref)) ?? []).map((r) => ({ type: r.ancestor_type, id: r.ancestor_id, depth: r.depth })));
  await replaceAncestors(list, closeOver(list, parents, outside, gone));
  return list.length;
}

// Before replaceAncestors deletes anything: the observer runs inside the write's transaction, so the write rolls back.
function refuseToDropUndeclared(list: readonly ResourceRef[], rows: ReadonlyMap<string, readonly AncestorRow[]>): void {
  const linked = new Map<ResourceType, Set<ResourceType>>();
  for (const n of list) {
    const types = linked.get(n.type) ?? new Set<ResourceType>();
    for (const r of rows.get(resourceKey(n)) ?? []) types.add(r.ancestor_type);
    linked.set(n.type, types);
  }
  for (const [type, types] of linked) {
    const undeclared = undeclaredAncestorTypes(type, types);
    if (undeclared.length > 0) throw new AuthzConfigError(`authz-orm: ${type}: ${undeclaredLinks(type, undeclared)}`);
  }
}

/** Recomputes `roots` and every resource the table lists below them (a move, an insert). */
export async function rebuildFrom(driver: OrmDriver, roots: readonly ResourceRef[]): Promise<number> {
  const list = unique(roots);
  if (list.length === 0) return 0;
  return rebuildNodes(driver, [...list, ...(await readDescendants(list))]);
}

/** Design §6.4 steps 1–2: drop the rows of the deleted resources and recompute what was below them without them. */
export async function removeNodes(driver: OrmDriver, deleted: readonly ResourceRef[]): Promise<void> {
  const list = unique(deleted);
  if (list.length === 0) return;
  const gone = new Set(list.map((n) => resourceKey(n)));
  const below = (await readDescendants(list)).filter((d) => !gone.has(resourceKey(d)));
  await deleteRowsOf(list);
  await rebuildNodes(driver, below, gone);
}
