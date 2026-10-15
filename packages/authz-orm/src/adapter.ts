import { AuthzConfigError, GLOBAL, ResourceAdapter, parsePermission, requestScope } from '@spinajs/authz';
import type { PermissionDef, RelationResolver, ResourceRef, ResourceType } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';
import { ModelBase } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { readAncestors } from './ancestors/read.js';
import { driverOf, idText, refKey } from './ids.js';
import { classesOf, entryOf, registeredTypes } from './registry.js';
import { ormRelations } from './relations.js';
import { findRows } from './rows.js';

const MEMO = 'authz-orm:';
const KINDS = ['read', 'create', 'update', 'delete'] as const;

/** Memoised per request store (none outside a store); a rejection is not kept. */
function memo<T>(key: string, load: () => Promise<T>): Promise<T> {
  let cache: Map<string, unknown> | undefined;
  try {
    cache = requestScope().cache;
  } catch {
    cache = undefined;
  }
  if (cache === undefined) return load();
  const hit = cache.get(key) as Promise<T> | undefined;
  if (hit !== undefined) return hit;
  const p = load();
  cache.set(key, p);
  p.catch(() => {
    if (cache!.get(key) === p) cache!.delete(key);
  });
  return p;
}

const typeLevel = (ref: ResourceRef): readonly ResourceRef[] => Object.freeze([Object.freeze({ type: ref.type }), GLOBAL]);

@Singleton()
@Injectable(ResourceAdapter)
export class OrmResourceAdapter extends ResourceAdapter<ModelBase> {
  readonly kind = 'orm';

  // A live view of the registry: tests and apps register models after the adapter exists. The base
  // class declares it as a property, so the getter goes on the instance.
  declare readonly types: readonly ResourceType[];

  constructor() {
    super();
    Object.defineProperty(this, 'types', { get: () => registeredTypes(), enumerable: true });
  }

  accepts(target: unknown): target is ModelBase {
    return target instanceof ModelBase && entryOf(target.constructor) !== undefined;
  }

  refOf(target: ModelBase): ResourceRef {
    const entry = entryOf(target.constructor);
    if (!entry) throw new AuthzConfigError(`authz-orm: ${target?.constructor?.name} is not an @AccessResource model`);
    const id = idText((target as unknown as Record<string, unknown>)[entry.idColumn]);
    if (id === undefined) throw new AuthzConfigError(`authz-orm: a ${entry.type} row without a primary key value has no ref`);
    return { type: entry.type, id };
  }

  ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null> {
    if (ref.id === undefined || ref.id === null) return Promise.resolve(typeLevel(ref));
    return memo(`${MEMO}ancestors:${refKey(ref)}`, async () => (await this.ancestorsMany([ref])).get(refKey(ref)) ?? null);
  }

  async ancestorsMany(refs: readonly ResourceRef[]): Promise<ReadonlyMap<string, readonly ResourceRef[] | null>> {
    const out = new Map<string, readonly ResourceRef[] | null>();
    const nodes: ResourceRef[] = [];
    for (const r of refs) {
      if (r.id === undefined || r.id === null) out.set(refKey(r), typeLevel(r));
      else nodes.push({ type: r.type, id: String(r.id) });
    }
    const found = await findRows(nodes);
    const byDriver = new Map<OrmDriver, ResourceRef[]>();
    for (const n of nodes) {
      const f = found.get(refKey(n));
      if (!f) continue;
      const d = driverOf(f.model);
      byDriver.set(d, [...(byDriver.get(d) ?? []), n]);
    }
    const rows = new Map<string, readonly { ancestor_type: string; ancestor_id: string }[]>();
    for (const [driver, list] of byDriver) for (const [k, v] of await readAncestors(driver, list)) rows.set(k, v);
    for (const n of nodes) {
      const key = refKey(n);
      if (!found.has(key)) {
        out.set(key, null);
        continue;
      }
      const chain = [{ type: n.type, id: n.id }, ...(rows.get(key) ?? []).map((a) => ({ type: a.ancestor_type, id: a.ancestor_id })), GLOBAL];
      out.set(key, Object.freeze(chain.map((r) => Object.freeze(r))));
    }
    return out;
  }

  load(ref: ResourceRef): Promise<unknown | null> {
    if (ref.id === undefined || ref.id === null) return Promise.resolve(null);
    return memo(`${MEMO}row:${refKey(ref)}`, async () => (await findRows([ref])).get(refKey(ref))?.row ?? null);
  }

  async loadMany(refs: readonly ResourceRef[]): Promise<ReadonlyMap<string, unknown>> {
    const out = new Map<string, unknown>();
    for (const [key, f] of await findRows(refs)) out.set(key, f.row);
    return out;
  }

  relations(): readonly RelationResolver[] {
    return ormRelations();
  }

  permissions(): readonly Omit<PermissionDef, 'source'>[] {
    // One def per name; a name several types use lists them all.
    const out = new Map<string, { name: string; resource: string; action: string; types: ResourceType[] }>();
    for (const type of registeredTypes()) {
      if (classesOf(type).length === 0) continue;
      for (const kind of KINDS) {
        const name = `${type}:${kind}`;
        const def = out.get(name);
        if (def === undefined) out.set(name, { name, ...parsePermission(name), types: [type] });
        else if (!def.types.includes(type)) def.types.push(type);
      }
    }
    return [...out.values()];
  }
}
