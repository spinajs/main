import { AuthzConfigError, CORE_FILTER_OPS, GLOBAL, ResourceAdapter, SYSTEM, parsePermission, requestScope, resourceKey, runWithPrincipal } from '@spinajs/authz';
import type { FilterOp, PermissionDef, RelationResolver, ResourceRef, ResourceType } from '@spinajs/authz';
import { DI, Injectable, Singleton } from '@spinajs/di';
import { ModelBase, extractModelDescriptor } from '@spinajs/orm';

import { OrmNativeCompiler } from './api.js';
import { columnOf, dialectOf, idMode, idText, idValue, normalize } from './columns.js';
import { classesOf, entryOf, registeredTypes } from './registry.js';
import type { ModelClass } from './registry.js';

const MEMO = 'authz-orm:';

type Row = ModelBase & Record<string, unknown>;

/** The registered `OrmNativeCompiler`s by op; two for one op is a configuration error. */
export function nativeCompilers(): ReadonlyMap<string, OrmNativeCompiler> {
  const list = (DI.resolve(Array.ofType(OrmNativeCompiler)) as unknown as OrmNativeCompiler[] | undefined) ?? [];
  const out = new Map<string, OrmNativeCompiler>();
  for (const c of list) {
    const prev = out.get(c.op);
    if (prev !== undefined && prev !== c) throw new AuthzConfigError(`authz-orm: two OrmNativeCompilers for ${c.op} (${prev.constructor.name}, ${c.constructor.name})`);
    out.set(c.op, c);
  }
  return out;
}

function pkOf(model: ModelClass): string {
  const pk = extractModelDescriptor(model as never)?.PrimaryKey;
  const name = Array.isArray(pk) ? pk[0] : pk;
  if (typeof name !== 'string' || name === '') throw new AuthzConfigError(`authz-orm: model ${model.name} has no primary key`);
  return name;
}

/** The row of `ref` among the classes of its type (registration order), loaded unscoped; null when none has it. */
export async function findRow(ref: ResourceRef): Promise<Row | null> {
  if (ref.id === undefined || ref.id === null) return null;
  const id = String(ref.id);
  for (const cls of classesOf(ref.type)) {
    const pk = pkOf(cls);
    const column = columnOf(cls, pk);
    if (!column) continue;
    const mode = idMode(column, dialectOf(extractModelDescriptor(cls as never)));
    const value = idValue(mode, id, column);
    if (value === undefined) continue;
    const model = cls as unknown as typeof ModelBase;
    const query = () => model.where(pk, value).first() as Promise<unknown>;
    const row = await runWithPrincipal(SYSTEM, query);
    if (row instanceof ModelBase && idText(mode, (row as Row)[pk]) === id) return row as Row;
  }
  return null;
}

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

function parseJson(value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}

@Singleton()
@Injectable(ResourceAdapter)
export class OrmResourceAdapter extends ResourceAdapter<ModelBase> {
  readonly kind = 'orm';

  // Live views of the registry: tests and apps register models after the adapter exists. The base
  // class declares both as properties, so getters go on the instance.
  declare readonly types: readonly ResourceType[];
  declare readonly compiles: readonly FilterOp[];

  constructor() {
    super();
    Object.defineProperties(this, {
      types: { get: () => registeredTypes(), enumerable: true },
      compiles: { get: () => [...CORE_FILTER_OPS, ...nativeCompilers().keys()] as FilterOp[], enumerable: true },
    });
  }

  accepts(target: unknown): target is ModelBase {
    return target instanceof ModelBase && entryOf(target.constructor) !== undefined;
  }

  refOf(target: ModelBase): ResourceRef {
    const entry = entryOf(target.constructor);
    if (!entry) throw new AuthzConfigError(`authz-orm: ${target?.constructor?.name} is not an @AccessResource model`);
    const value = (target as Row)[pkOf(target.constructor)];
    if (value === undefined || value === null) throw new AuthzConfigError(`authz-orm: a ${entry.type} row without a primary key value has no ref`);
    return { type: entry.type, id: String(value) };
  }

  ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null> {
    if (ref.id === undefined || ref.id === null) return Promise.resolve([{ type: ref.type }, GLOBAL]);
    return memo(`${MEMO}ancestors:${resourceKey(ref)}`, async () => {
      const row = await findRow(ref);
      if (!row) return null;
      const entry = entryOf(row.constructor)!;
      const dialect = dialectOf(extractModelDescriptor(row.constructor as never));
      const out: ResourceRef[] = [{ type: ref.type, id: String(ref.id) }];
      for (const s of entry.scopeColumns) {
        const column = columnOf(row.constructor, s.column);
        // The ORM hydrates by column name. A column it does not know, or a value that is no id of the
        // column's mode, is no ancestor; the SQL `under` tests the same (conventions §5).
        const id = column ? idText(idMode(column, dialect), row[s.column]) : undefined;
        if (id !== undefined) out.push({ type: s.scopeType, id });
      }
      out.push(GLOBAL);
      return Object.freeze(out.map((r) => Object.freeze(r)));
    });
  }

  load(ref: ResourceRef): Promise<unknown | null> {
    return findRow(ref);
  }

  attribute(subject: unknown, field: string): unknown {
    if (!(subject instanceof ModelBase)) return undefined;
    const column = columnOf(subject.constructor, field);
    if (!column) return undefined;
    return normalize(column.kind, (subject as Row)[field]);
  }

  async scopeAttributes(ref: ResourceRef): Promise<Readonly<Record<string, unknown>> | null> {
    const row = await findRow(ref);
    if (!row) return null;
    const entry = entryOf(row.constructor)!;
    const out: Record<string, unknown> = {};
    for (const name of entry.attributes) {
      const column = columnOf(row.constructor, name);
      if (!column) continue;
      let value: unknown = row[name];
      if (value === undefined) continue;
      if (typeof value === 'string' && /json/i.test(String(column.descriptor.NativeType ?? column.descriptor.Type ?? ''))) {
        const parsed = parseJson(value);
        if (!parsed.ok) continue;
        value = parsed.value;
      }
      out[name] = value;
    }
    return out;
  }

  relations(): readonly RelationResolver[] {
    return [];
  }

  permissions(): readonly Omit<PermissionDef, 'source'>[] {
    // One def per name; a name several types use (custom permissions) lists them all.
    const out = new Map<string, { name: string; resource: string; action: string; types: ResourceType[] }>();
    for (const type of registeredTypes()) {
      for (const cls of classesOf(type)) {
        for (const name of Object.values(entryOf(cls)!.permissions)) {
          const def = out.get(name);
          if (def === undefined) out.set(name, { name, ...parsePermission(name), types: [type] });
          else if (!def.types.includes(type)) def.types.push(type);
        }
      }
    }
    return [...out.values()];
  }
}
