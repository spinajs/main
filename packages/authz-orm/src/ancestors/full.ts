import { AuthzConfigError, resourceKey } from '@spinajs/authz';
import type { ResourceRef, ResourceType } from '@spinajs/authz';
import type { OrmDriver } from '@spinajs/orm';

import { idText, tableOf } from '../ids.js';
import { classesOf, entryOf, typesAbove } from '../registry.js';
import { closeOver } from './closure.js';
import { ANCESTOR_COLUMNS, AUTHZ_RESOURCE_ANCESTOR_TABLE } from './table.js';
import type { AncestorRow } from './table.js';

const linkKey = (r: AncestorRow): string => `${r.resource_type}:${r.resource_id}>${r.ancestor_type}:${r.ancestor_id}`;

/** Every row of `types` with its parents, read whole from each class table (once per table). */
async function loadParents(driver: OrmDriver, types: readonly ResourceType[]): Promise<{ nodes: Map<string, ResourceRef[]>; ofType: Map<ResourceType, ResourceRef[]> }> {
  const nodes = new Map<string, ResourceRef[]>();
  const ofType = new Map<ResourceType, ResourceRef[]>();
  for (const type of types) {
    const refs: ResourceRef[] = [];
    ofType.set(type, refs);
    const tables = new Set<string>();
    for (const cls of classesOf(type)) {
      const entry = entryOf(cls)!;
      const table = tableOf(cls);
      if (tables.has(table)) continue;
      tables.add(table);
      const rows = (await driver
        .select()
        .from(table)
        .columns([entry.idColumn, ...new Set(entry.parents.map((p) => p.column))])) as Record<string, unknown>[];
      for (const row of rows) {
        const id = idText(row[entry.idColumn]);
        if (id === undefined || nodes.has(resourceKey({ type, id }))) continue;
        const parents: ResourceRef[] = [];
        for (const p of entry.parents) {
          const pid = idText(row[p.column]);
          if (pid !== undefined) parents.push({ type: p.type, id: pid });
        }
        nodes.set(resourceKey({ type, id }), parents);
        refs.push({ type, id });
      }
    }
  }
  return { nodes, ofType };
}

/** The rows `type` should have: its rows' closure over the types above it, from the `@Parent` columns. */
export async function expectedRows(driver: OrmDriver, type: ResourceType): Promise<AncestorRow[]> {
  if (classesOf(type).length === 0) return [];
  const { nodes, ofType } = await loadParents(driver, [type, ...typesAbove(type)]);
  const all = [...nodes.keys()].map((k) => {
    const at = k.indexOf(':');
    return { type: k.slice(0, at), id: k.slice(at + 1) };
  });
  const closure = closeOver(all, nodes, new Map());
  const out: AncestorRow[] = [];
  for (const n of ofType.get(type) ?? []) for (const l of closure.get(resourceKey(n)) ?? []) out.push({ resource_type: type, resource_id: String(n.id), ancestor_type: l.type, ancestor_id: l.id, depth: l.depth });
  return out;
}

export async function actualRows(driver: OrmDriver, type: ResourceType): Promise<AncestorRow[]> {
  const rows = (await driver
    .select()
    .from(AUTHZ_RESOURCE_ANCESTOR_TABLE)
    .columns([...ANCESTOR_COLUMNS])
    .where('resource_type', type)) as Record<string, unknown>[];
  return rows.map((r) => ({ resource_type: String(r.resource_type), resource_id: String(r.resource_id), ancestor_type: String(r.ancestor_type), ancestor_id: String(r.ancestor_id), depth: Number(r.depth) }));
}

/** Resource types that have rows in the table. */
export async function listedTypes(driver: OrmDriver): Promise<ResourceType[]> {
  const rows = (await driver.select().from(AUTHZ_RESOURCE_ANCESTOR_TABLE).columns(['resource_type']).distinct()) as Record<string, unknown>[];
  return rows.map((r) => String(r.resource_type));
}

export interface RowDiff {
  readonly missing: string[];
  readonly extra: string[];
  readonly depth: string[];
}

export function diffRows(expected: readonly AncestorRow[], actual: readonly AncestorRow[]): RowDiff {
  const want = new Map(expected.map((r) => [linkKey(r), r]));
  const have = new Map(actual.map((r) => [linkKey(r), r]));
  const missing: string[] = [];
  const extra: string[] = [];
  const depth: string[] = [];
  for (const [k, r] of want) {
    const h = have.get(k);
    if (!h) missing.push(`${k}@${r.depth}`);
    else if (h.depth !== r.depth) depth.push(`${k} expected ${r.depth}, found ${h.depth}`);
  }
  for (const [k, r] of have) if (!want.has(k)) extra.push(`${k}@${r.depth}`);
  return { missing: missing.sort(), extra: extra.sort(), depth: depth.sort() };
}

export function requireType(type: string): ResourceType {
  if (classesOf(type).length === 0) throw new AuthzConfigError(`authz:ancestors: no @AccessResource model has type '${type}'`);
  return type;
}
