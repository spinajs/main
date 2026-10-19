import { AuthzConfigError, GLOBAL } from '@spinajs/authz';
import type { ResourceType } from '@spinajs/authz';
import { extractModelDescriptor } from '@spinajs/orm';

// Every module of the package reaches the registry, so a second copy fails before it registers anything.
import './once.js';

// eslint-disable-next-line @typescript-eslint/ban-types
export type ModelClass = Function;

export interface ParentEntry {
  readonly property: string;
  readonly column: string;
  readonly type: ResourceType;
  readonly nullable: boolean;
}

export interface ResourceEntry {
  /** The registered class; for a subclass looked up through the chain, its nearest registered ancestor. */
  readonly registered: ModelClass;
  readonly type: ResourceType;
  readonly parents: readonly ParentEntry[];
  /** Without `typeColumn` the owner is a `user` principal; with it, the row's type column names the principal type. */
  readonly owner?: { readonly property: string; readonly column: string; readonly typeColumn?: string };
  readonly self?: { readonly column: string };
  readonly idColumn: string;
}

export interface OwnerColumns {
  readonly column: string;
  readonly typeColumn?: string;
}

export interface RegistrationOptions {
  readonly parents?: readonly { readonly column: string; readonly type: ResourceType }[];
  readonly owner?: string | OwnerColumns;
  readonly self?: string;
}

interface Registration {
  readonly type: ResourceType;
  readonly parents: readonly ParentEntry[];
  readonly owner?: OwnerColumns;
  readonly self?: string;
  /** Canonical form, to tell an idempotent re-registration from a conflicting one. */
  readonly key: string;
}

interface PropertyMetadata {
  owner?: OwnerColumns;
  self?: string;
  readonly parents: ParentEntry[];
}

const sameOwner = (a: OwnerColumns, b: OwnerColumns): boolean => a.column === b.column && a.typeColumn === b.typeColumn;
const showOwner = (o: OwnerColumns): string => (o.typeColumn === undefined ? `'${o.column}'` : `'${o.column}' (type column '${o.typeColumn}')`);

// Insertion order is registration order (lookups by type rely on it).
const registrations = new Map<ModelClass, Registration>();
// Property decorators run before the class decorator, and on classes registerAccessResource may never see.
const properties = new WeakMap<ModelClass, PropertyMetadata>();
// entryOf runs for every query builder; any registry write clears it.
let entries = new WeakMap<ModelClass, ResourceEntry | null>();
let version = 0;

/** Changes whenever a class is registered or forgotten. */
export const registryVersion = (): number => version;

export const nameOf = (c: unknown): string => (typeof c === 'function' && c.name ? c.name : '<anonymous class>');

function chain(model: ModelClass): ModelClass[] {
  const out: ModelClass[] = [];
  for (let c: unknown = model; typeof c === 'function' && c !== Function.prototype; c = Object.getPrototypeOf(c)) out.push(c as ModelClass);
  return out;
}

export function checkType(type: unknown, where: string): ResourceType {
  if (typeof type !== 'string' || type.length === 0) throw new AuthzConfigError(`${where}: the type must be a non-empty string`);
  if (type === GLOBAL.type) throw new AuthzConfigError(`${where}: '${GLOBAL.type}' is not a resource type`);
  return type;
}

function checkColumn(column: unknown, where: string): string {
  if (typeof column !== 'string' || column.length === 0) throw new AuthzConfigError(`${where}: a column must be a non-empty string`);
  return column;
}

export function ownerColumns(owner: unknown, where: string): OwnerColumns {
  if (typeof owner === 'string') return { column: checkColumn(owner, where) };
  if (owner === null || typeof owner !== 'object') throw new AuthzConfigError(`${where}: the owner must be a column name or { column, typeColumn? }`);
  const o = owner as Record<string, unknown>;
  const column = checkColumn(o.column, where);
  if (o.typeColumn === undefined) return { column };
  const typeColumn = checkColumn(o.typeColumn, `${where} typeColumn`);
  if (typeColumn === column) throw new AuthzConfigError(`${where}: typeColumn must differ from the owner column`);
  return { column, typeColumn };
}

function normalize(model: ModelClass, type: unknown, opts: unknown): Registration {
  const where = `${nameOf(model)}: @AccessResource`;
  const t = checkType(type, where);
  if (opts !== undefined && (opts === null || typeof opts !== 'object')) throw new AuthzConfigError(`${where}('${t}'): options must be an object`);
  const o = (opts ?? {}) as RegistrationOptions;
  for (const k of Object.keys(o)) if (!['parents', 'owner', 'self'].includes(k)) throw new AuthzConfigError(`${where}('${t}'): unknown option '${k}'`);
  if (o.parents !== undefined && !Array.isArray(o.parents)) throw new AuthzConfigError(`${where}('${t}'): parents must be a list of { column, type }`);
  const parents = (o.parents ?? []).map((p) => {
    const column = checkColumn(p?.column, `${where}('${t}') parents`);
    return Object.freeze({ property: column, column, type: checkType(p?.type, `${where}('${t}') parent ${column}`), nullable: false });
  });
  const owner = o.owner === undefined ? undefined : ownerColumns(o.owner, `${where}('${t}') owner`);
  const self = o.self === undefined ? undefined : checkColumn(o.self, `${where}('${t}') self`);
  const key = JSON.stringify([t, parents.map((p) => [p.column, p.type]), owner ? [owner.column, owner.typeColumn ?? null] : null, self ?? null]);
  return { type: t, parents, ...(owner !== undefined ? { owner } : {}), ...(self !== undefined ? { self } : {}), key };
}

export function register(model: ModelClass, type: unknown, opts?: unknown): void {
  if (typeof model !== 'function') throw new AuthzConfigError('registerAccessResource: the model must be a class');
  const next = normalize(model, type, opts);
  const prev = registrations.get(model);
  if (prev !== undefined) {
    if (prev.key === next.key) return;
    throw new AuthzConfigError(`${nameOf(model)} is already registered as resource '${prev.type}' with other options`);
  }
  // Only an owner on another column fails here; entryOf compares the type columns too.
  const decorated = chain(model)
    .map((c) => properties.get(c)?.owner)
    .find((o) => o !== undefined);
  if (next.owner !== undefined && decorated !== undefined && decorated.column !== next.owner.column) {
    throw new AuthzConfigError(`${nameOf(model)}: the owner is @Owner() ${showOwner(decorated)} and registered as ${showOwner(next.owner)}`);
  }
  registrations.set(model, next);
  entries = new WeakMap();
  version++;
}

function metadataOf(model: ModelClass): PropertyMetadata {
  let m = properties.get(model);
  if (m === undefined) properties.set(model, (m = { parents: [] }));
  return m;
}

export function setOwner(model: ModelClass, owner: OwnerColumns): void {
  const m = metadataOf(model);
  if (m.owner !== undefined && !sameOwner(m.owner, owner)) throw new AuthzConfigError(`${nameOf(model)}: @Owner() is on ${showOwner(m.owner)} already; a model has one owner property`);
  m.owner = owner;
  entries = new WeakMap();
}

export function setSelf(model: ModelClass, property: string): void {
  const m = metadataOf(model);
  if (m.self !== undefined && m.self !== property) throw new AuthzConfigError(`${nameOf(model)}: @Self() is on '${m.self}' already; a model has one self property`);
  m.self = property;
  entries = new WeakMap();
}

export function addParent(model: ModelClass, parent: ParentEntry): void {
  const m = metadataOf(model);
  if (m.parents.some((p) => p.property === parent.property)) throw new AuthzConfigError(`${nameOf(model)}.${parent.property}: one @Parent per property`);
  m.parents.push(Object.freeze({ ...parent }));
  entries = new WeakMap();
}

function pkOf(model: ModelClass): string {
  const pk = extractModelDescriptor(model as never)?.PrimaryKey as unknown;
  const name = Array.isArray(pk) ? pk[0] : pk;
  if (typeof name !== 'string' || name === '') throw new AuthzConfigError(`authz-orm: @AccessResource model ${nameOf(model)} has no primary key`);
  return name;
}

/** The entry of `model` or of its nearest registered ancestor; property metadata merges over the whole chain of `model`. */
export function entryOf(model: unknown): ResourceEntry | undefined {
  if (typeof model !== 'function') return undefined;
  const cached = entries.get(model);
  if (cached !== undefined) return cached ?? undefined;
  const entry = buildEntry(model);
  entries.set(model, entry ?? null);
  return entry;
}

function buildEntry(model: ModelClass): ResourceEntry | undefined {
  const classes = chain(model);
  const registered = classes.find((c) => registrations.has(c));
  if (registered === undefined) return undefined;
  const r = registrations.get(registered)!;
  const where = `${nameOf(model)} (resource '${r.type}')`;

  let owner: OwnerColumns | undefined;
  let self: string | undefined;
  const parents: ParentEntry[] = [];
  // Base first, so a subclass's own declarations follow the inherited ones and its @Owner wins.
  for (const c of [...classes].reverse()) {
    const m = properties.get(c);
    if (m === undefined) continue;
    if (m.owner !== undefined) owner = m.owner;
    if (m.self !== undefined) self = m.self;
    for (const p of m.parents) {
      const i = parents.findIndex((x) => x.property === p.property);
      if (i === -1) parents.push(p);
      else parents[i] = p;
    }
  }
  for (const p of r.parents) {
    const same = parents.find((x) => x.column === p.column);
    if (same && same.type !== p.type) throw new AuthzConfigError(`${where}: parent column ${p.column} is @Parent('${same.type}') and registered as '${p.type}'`);
    if (!same) parents.push(p);
  }
  if (r.owner !== undefined && owner !== undefined && !sameOwner(r.owner, owner)) throw new AuthzConfigError(`${where}: the owner is @Owner() ${showOwner(owner)} and registered as ${showOwner(r.owner)}`);
  if (r.self !== undefined && self !== undefined && r.self !== self) throw new AuthzConfigError(`${where}: self is @Self() '${self}' and registered as '${r.self}'`);
  owner ??= r.owner;
  self ??= r.self;

  return Object.freeze({
    registered,
    type: r.type,
    parents: Object.freeze(parents),
    ...(owner !== undefined ? { owner: Object.freeze({ property: owner.column, column: owner.column, ...(owner.typeColumn !== undefined ? { typeColumn: owner.typeColumn } : {}) }) } : {}),
    ...(self !== undefined ? { self: Object.freeze({ column: self }) } : {}),
    idColumn: pkOf(model),
  });
}

export function isRegistered(model: unknown): boolean {
  return entryOf(model) !== undefined;
}

/** Registered classes of `type`, in registration order. */
export function classesOf(type: ResourceType): ModelClass[] {
  return [...registrations].filter(([, r]) => r.type === type).map(([c]) => c);
}

/** Every registered type, in first-registration order. */
export function registeredTypes(): ResourceType[] {
  return [...new Set([...registrations.values()].map((r) => r.type))];
}

export function registeredClasses(): ModelClass[] {
  return [...registrations.keys()];
}

/** The parent types of `type`'s classes, transitively, nearest first; `type` itself only when it is its own ancestor type. */
export function typesAbove(type: ResourceType): ResourceType[] {
  const out: ResourceType[] = [];
  const queue: ResourceType[] = [type];
  while (queue.length > 0) {
    const t = queue.shift()!;
    for (const c of classesOf(t)) {
      for (const p of entryOf(c)?.parents ?? []) {
        if (out.includes(p.type) || p.type === type) continue;
        out.push(p.type);
        queue.push(p.type);
      }
    }
  }
  return out;
}

/** Test seam: forget a class's registration. Its decorated properties stay, so it can register again. */
export function unregisterResource(model: ModelClass): void {
  registrations.delete(model);
  entries = new WeakMap();
  version++;
}

/** Test seam: forget every registration (decorator metadata stays). */
export function resetRegistry(): void {
  registrations.clear();
  entries = new WeakMap();
  version++;
}
