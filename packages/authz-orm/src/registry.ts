import { AuthzConfigError, GLOBAL, isPermission } from '@spinajs/authz';
import type { Permission, ResourceType } from '@spinajs/authz';

// Every module of the package reaches the registry, so a second copy fails before it registers anything.
import './once.js';

export type QueryKind = 'read' | 'create' | 'update' | 'delete';

export const QUERY_KINDS: readonly QueryKind[] = Object.freeze(['read', 'create', 'update', 'delete'] as const);

export interface AccessResourceOptions {
  readonly relationScope?: 'where' | 'join';
  readonly permissions?: { readonly read?: Permission; readonly create?: Permission; readonly update?: Permission; readonly delete?: Permission };
  readonly attributes?: readonly string[];
}

export interface ScopeColumnEntry {
  /** The model property holding the value. */
  readonly property: string;
  /** The DB column. */
  readonly column: string;
  readonly scopeType: ResourceType;
}

// eslint-disable-next-line @typescript-eslint/ban-types
export type ModelClass = Function;

export interface ResourceEntry {
  /** The registered class; for a subclass looked up through the chain, its nearest registered ancestor. */
  readonly registered: ModelClass;
  readonly type: ResourceType;
  readonly relationScope: 'where' | 'join';
  readonly permissions: Readonly<Record<QueryKind, Permission>>;
  readonly attributes: readonly string[];
  /** The `@Owner()` property. */
  readonly owner?: string;
  /** Declaration order, nearest ancestor first. */
  readonly scopeColumns: readonly ScopeColumnEntry[];
}

interface Registration {
  readonly type: ResourceType;
  readonly relationScope: 'where' | 'join';
  readonly permissions: Readonly<Record<QueryKind, Permission>>;
  readonly attributes: readonly string[];
  /** Canonical form of the options, to tell an idempotent re-registration from a conflicting one. */
  readonly key: string;
}

interface PropertyMetadata {
  owner?: string;
  readonly scopeColumns: ScopeColumnEntry[];
}

// Insertion order is registration order (lookups by type rely on it).
const registrations = new Map<ModelClass, Registration>();
// Property decorators run before the class decorator, and on classes that registerAccessResource may never see.
const properties = new WeakMap<ModelClass, PropertyMetadata>();
// Decorators write these once, at class definition, so the test seams never drop them.
const scopes = new WeakMap<ModelClass, Map<string, ModelClass>>();
// entryOf runs for every query builder; any registry write clears it.
let entries = new WeakMap<ModelClass, ResourceEntry | null>();
let version = 0;

/** Changes whenever a class is registered or forgotten. */
export const registryVersion = (): number => version;

const nameOf = (c: unknown): string => (typeof c === 'function' && c.name ? c.name : '<anonymous class>');

function chain(model: ModelClass): ModelClass[] {
  const out: ModelClass[] = [];
  for (let c: unknown = model; typeof c === 'function' && c !== Function.prototype; c = Object.getPrototypeOf(c)) out.push(c as ModelClass);
  return out;
}

function normalize(model: ModelClass, type: unknown, opts: unknown): Registration {
  const where = `${nameOf(model)}: @AccessResource`;
  if (typeof type !== 'string' || type.length === 0) throw new AuthzConfigError(`${where}: the type must be a non-empty string`);
  if (type === GLOBAL.type) throw new AuthzConfigError(`${where}: '${GLOBAL.type}' is not a resource type`);
  if (opts !== undefined && (opts === null || typeof opts !== 'object')) throw new AuthzConfigError(`${where}('${type}'): options must be an object`);
  const o = (opts ?? {}) as AccessResourceOptions;

  const relationScope = o.relationScope ?? 'where';
  if (relationScope !== 'where' && relationScope !== 'join') throw new AuthzConfigError(`${where}('${type}'): relationScope must be 'where' or 'join'`);

  if (o.permissions !== undefined && (o.permissions === null || typeof o.permissions !== 'object')) throw new AuthzConfigError(`${where}('${type}'): permissions must be an object`);
  const permissions = {} as Record<QueryKind, Permission>;
  for (const kind of QUERY_KINDS) {
    const name = o.permissions?.[kind] ?? `${type}:${kind}`;
    if (!isPermission(name)) throw new AuthzConfigError(`${where}('${type}'): ${JSON.stringify(name)} is not a valid ${kind} permission name`);
    permissions[kind] = name;
  }
  for (const k of Object.keys(o.permissions ?? {})) {
    if (!(QUERY_KINDS as readonly string[]).includes(k)) throw new AuthzConfigError(`${where}('${type}'): unknown permission key '${k}'`);
  }

  const attributes = o.attributes ?? [];
  if (!Array.isArray(attributes) || attributes.some((a) => typeof a !== 'string' || a.length === 0)) throw new AuthzConfigError(`${where}('${type}'): attributes must be a list of column names`);

  const frozen = Object.freeze([...attributes]);
  const key = JSON.stringify([type, relationScope, QUERY_KINDS.map((k) => permissions[k]), frozen]);
  return { type, relationScope, permissions: Object.freeze(permissions), attributes: frozen, key };
}

export function register(model: ModelClass, type: unknown, opts?: unknown): void {
  if (typeof model !== 'function') throw new AuthzConfigError('registerAccessResource: the model must be a class');
  const next = normalize(model, type, opts);
  const prev = registrations.get(model);
  if (prev !== undefined) {
    if (prev.key === next.key) return;
    throw new AuthzConfigError(`${nameOf(model)} is already registered as resource '${prev.type}' with other options`);
  }
  registrations.set(model, next);
  entries = new WeakMap();
  version++;
}

function metadataOf(model: ModelClass): PropertyMetadata {
  let m = properties.get(model);
  if (m === undefined) properties.set(model, (m = { scopeColumns: [] }));
  return m;
}

export function setOwner(model: ModelClass, property: string): void {
  const m = metadataOf(model);
  if (m.owner !== undefined && m.owner !== property) throw new AuthzConfigError(`${nameOf(model)}: @Owner() is on '${m.owner}' already; a model has one owner property`);
  m.owner = property;
  entries = new WeakMap();
}

export function addScopeColumn(model: ModelClass, entry: ScopeColumnEntry): void {
  const m = metadataOf(model);
  if (m.scopeColumns.some((s) => s.property === entry.property)) throw new AuthzConfigError(`${nameOf(model)}.${entry.property}: one @ScopeColumn per property`);
  m.scopeColumns.push(Object.freeze({ ...entry }));
  entries = new WeakMap();
}

export function addScopePolicy(model: ModelClass, relation: string, policy: ModelClass): void {
  let byRelation = scopes.get(model);
  if (byRelation === undefined) scopes.set(model, (byRelation = new Map()));
  const prev = byRelation.get(relation);
  if (prev !== undefined && prev !== policy) throw new AuthzConfigError(`@OrmScope(${nameOf(model)}, '${relation}'): ${nameOf(prev)} is already the policy of that relation; ${nameOf(policy)} cannot be another`);
  byRelation.set(relation, policy);
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

  let owner: string | undefined;
  const scopeColumns: ScopeColumnEntry[] = [];
  // Base first, so a subclass's own columns follow the inherited ones and its @Owner wins.
  for (const c of [...classes].reverse()) {
    const m = properties.get(c);
    if (m === undefined) continue;
    if (m.owner !== undefined) owner = m.owner;
    for (const s of m.scopeColumns) {
      const i = scopeColumns.findIndex((x) => x.property === s.property);
      if (i === -1) scopeColumns.push(s);
      else scopeColumns[i] = s;
    }
  }

  return Object.freeze({ registered, type: r.type, relationScope: r.relationScope, permissions: r.permissions, attributes: r.attributes, ...(owner !== undefined ? { owner } : {}), scopeColumns: Object.freeze(scopeColumns) });
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

/** The `@OrmScope` policy class for `relation` on `model` or its nearest ancestor that has one. */
export function scopePolicyOf(model: unknown, relation: string): ModelClass | undefined {
  if (typeof model !== 'function') return undefined;
  for (const c of chain(model)) {
    const p = scopes.get(c)?.get(relation);
    if (p !== undefined) return p;
  }
  return undefined;
}

/** Relations with an `@OrmScope` policy on `model`'s chain. */
export function scopeRelationsOf(model: unknown): string[] {
  if (typeof model !== 'function') return [];
  const out = new Set<string>();
  for (const c of chain(model)) for (const r of scopes.get(c)?.keys() ?? []) out.add(r);
  return [...out];
}

export function permissionFor(model: unknown, kind: QueryKind): Permission | undefined {
  return entryOf(model)?.permissions[kind];
}

/** Test seam: forget a class's registration. Its decorated properties and scope policies stay, so it can register again. */
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
