import { AuthzConfigError, resourceKey } from '@spinajs/authz';
import type { ResourceRef, ResourceType } from '@spinajs/authz';
import type { OrmDriver } from '@spinajs/orm';

import { idText, tableOf } from '../ids.js';
import { selectFrom } from '../records.js';
import { classesOf, entryOf, typesAbove } from '../registry.js';
import { closeOver } from './closure.js';
import { AncestorRecord } from './record.js';
import type { AncestorRow } from './table.js';

const linkKey = (r: AncestorRow): string => `${r.resource_type}:${r.resource_id}>${r.ancestor_type}:${r.ancestor_id}`;

/**
 * Every row of `types` with its parents, read whole from each class table through a class that declares `@Parent` (once per
 * table), and the keys of every row of those types, the rows of tables only parentless classes map included.
 */
async function loadParents(driver: OrmDriver, types: readonly ResourceType[]): Promise<{ nodes: Map<string, ResourceRef[]>; ofType: Map<ResourceType, ResourceRef[]>; existing: Set<string> }> {
  const nodes = new Map<string, ResourceRef[]>();
  const ofType = new Map<ResourceType, ResourceRef[]>();
  const existing = new Set<string>();
  for (const type of types) {
    const refs: ResourceRef[] = [];
    ofType.set(type, refs);
    const tables = new Set<string>();
    // spinajs-orm-ignore ORM102: one query per distinct class table of the type; the tables differ, so they cannot share a select
    for (const cls of classesOf(type)) {
      const entry = entryOf(cls)!;
      const table = tableOf(cls);
      if (entry.parents.length === 0 || tables.has(table)) continue;
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
    await addIdsOfUnreadTables(driver, type, tables, existing);
  }
  for (const key of nodes.keys()) existing.add(key);
  return { nodes, ofType, existing };
}

async function addIdsOfUnreadTables(driver: OrmDriver, type: ResourceType, read: Set<string>, existing: Set<string>): Promise<void> {
  // spinajs-orm-ignore ORM102: one query per distinct class table of the type; the tables differ, so they cannot share a select
  for (const cls of classesOf(type)) {
    const entry = entryOf(cls);
    const table = tableOf(cls);
    if (entry === undefined || read.has(table)) continue;
    read.add(table);
    for (const row of (await driver.select().from(table).columns([entry.idColumn])) as Record<string, unknown>[]) {
      const id = idText(row[entry.idColumn]);
      if (id !== undefined) existing.add(resourceKey({ type, id }));
    }
  }
}

/** `parents` without the refs whose row is missing; a type no class of this process registers cannot be checked and stays. */
export function existingParentsOnly(parents: ReadonlyMap<string, readonly ResourceRef[]>, existing: ReadonlySet<string>): Map<string, ResourceRef[]> {
  return new Map([...parents].map(([key, refs]) => [key, refs.filter((p) => classesOf(p.type).length === 0 || existing.has(resourceKey(p)))]));
}

/** The rows `type` should have: its rows' closure over the types above it, from the `@Parent` columns. */
export async function expectedRows(driver: OrmDriver, type: ResourceType): Promise<AncestorRow[]> {
  if (classesOf(type).length === 0) return [];
  const { nodes, ofType, existing } = await loadParents(driver, [type, ...typesAbove(type)]);
  const all = [...nodes.keys()].map((k) => {
    const at = k.indexOf(':');
    return { type: k.slice(0, at), id: k.slice(at + 1) };
  });
  const closure = closeOver(all, existingParentsOnly(nodes, existing), new Map());
  const out: AncestorRow[] = [];
  for (const n of ofType.get(type) ?? []) for (const l of closure.get(resourceKey(n)) ?? []) out.push({ resource_type: type, resource_id: String(n.id), ancestor_type: l.type, ancestor_id: l.id, depth: l.depth });
  return out;
}

export async function actualRows(type: ResourceType): Promise<AncestorRow[]> {
  return await selectFrom(AncestorRecord).where('resource_type', type);
}

/** The ancestor types the table lists for rows of `type`. */
export async function ancestorTypesOf(type: ResourceType): Promise<ResourceType[]> {
  return (await selectFrom(AncestorRecord).columns(['ancestor_type']).distinct().where('resource_type', type)).map((r) => r.ancestor_type);
}

/** The types among `linked` that no `@Parent` chain of `type` reaches in this process (all of them for a type no class declares). */
export function undeclaredAncestorTypes(type: ResourceType, linked: Iterable<ResourceType>): ResourceType[] {
  const declared = new Set<ResourceType>([type, ...typesAbove(type)]);
  return [...new Set(linked)].filter((t) => !declared.has(t)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function undeclaredLinks(type: ResourceType, undeclared: readonly ResourceType[]): string {
  // --prune in a process that merely did not load the model would delete every row of the type.
  if (classesOf(type).length === 0) return `rows link to ${undeclared.join(', ')}, and no model of ${type} is loaded in this process; load that model in this process, or, if it was removed for good, delete its rows with authz:ancestors-rebuild ${type} --prune`;
  return `rows link to ${undeclared.join(', ')}, which no @Parent of ${type} names in this process; import the module that declares that parent in this process (a CLI loads it from a file of system.dirs.cli), or delete those links for good with authz:ancestors-rebuild ${type} --prune`;
}

/** Resource types that have rows in the table. */
export async function listedTypes(): Promise<ResourceType[]> {
  return (await selectFrom(AncestorRecord).columns(['resource_type']).distinct()).map((r) => r.resource_type);
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
