import { AuthzConfigError } from '../contracts/errors.js';
import type { ResourceType } from '../contracts/principal.js';
import type { ScopeAttributeSchema } from '../contracts/adapter.js';

const MAX_DEPTH = 32;
// Every key and array element counts, so neither shared subtrees nor a list claiming a huge length can stall a merge.
const MAX_VALUES = 10_000;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

type Obj = Record<string, unknown>;
interface Walk {
  readonly path: Set<object>;
  readonly layer: number;
  left: number;
}

/** Schema defaults per scope type. */
export function schemaIndex(schemas: readonly ScopeAttributeSchema[] | undefined): ReadonlyMap<ResourceType, Readonly<Record<string, unknown>>> {
  const index = new Map<ResourceType, Readonly<Record<string, unknown>>>();
  if (schemas === undefined) return index;
  if (!Array.isArray(schemas)) throw new AuthzConfigError('scope attribute schemas must be a list');

  for (const schema of schemas as unknown[]) {
    if (schema === null || typeof schema !== 'object') throw new AuthzConfigError('a scope attribute schema must be an object');
    let scopeType: unknown;
    let defaults: unknown;
    let plain: boolean;
    try {
      ({ scopeType, defaults } = schema as { scopeType?: unknown; defaults?: unknown });
      plain = isPlainObject(defaults);
    } catch (e) {
      throw new AuthzConfigError('a scope attribute schema cannot be read', { cause: e });
    }
    if (typeof scopeType !== 'string' || scopeType === '') throw new AuthzConfigError('a scope attribute schema must name its scopeType');
    if (index.has(scopeType)) throw new AuthzConfigError(`two scope attribute schemas for type '${scopeType}'`);
    if (!plain) throw new AuthzConfigError(`the defaults of the scope attribute schema for '${scopeType}' must be a plain object`);
    index.set(scopeType, mergeAttributes([defaults]));
  }
  return index;
}

/**
 * Left to right, later layers win; plain objects merge, everything else
 * replaces. A value the engine cannot represent removes its key, also from
 * earlier layers, so a default never shows through an unreadable override.
 * Dates become ISO strings: a frozen Date still changes through its setters,
 * and the result is shared by every model of the request.
 */
export function mergeAttributes(layers: readonly unknown[]): Readonly<Record<string, unknown>> {
  if (!Array.isArray(layers)) throw new AuthzConfigError('scope attribute layers must be a list');
  const out: Obj = {};
  let left = MAX_VALUES;
  for (let i = 0; i < layers.length; i++) {
    const layer: unknown = layers[i];
    let plain: boolean;
    try {
      plain = isPlainObject(layer);
    } catch (e) {
      throw new AuthzConfigError(`scope attribute layer ${i} cannot be read`, { cause: e });
    }
    if (!plain) throw new AuthzConfigError(`scope attribute layer ${i} must be a plain object`);
    const walk: Walk = { path: new Set(), layer: i, left };
    if (!mergeInto(out, layer as Obj, 1, walk)) throw new AuthzConfigError(`scope attribute layer ${i} cannot be read`);
    left = walk.left;
  }
  return deepFreeze(out);
}

/** False when the source's keys cannot be read; nothing was merged then. */
function mergeInto(target: Obj, source: Obj, depth: number, walk: Walk): boolean {
  enter(source, depth, walk);
  try {
    let keys: string[];
    try {
      keys = Object.keys(source);
    } catch {
      return false;
    }
    spend(walk, keys.length);
    for (const k of keys) {
      if (UNSAFE_KEYS.has(k)) continue;
      let v: unknown;
      try {
        v = source[k];
      } catch {
        delete target[k];
        continue;
      }
      if (v === undefined) continue;

      const current = Object.hasOwn(target, k) ? target[k] : undefined;
      if (isPlainSafe(v) && isPlainSafe(current)) {
        if (!mergeInto(current as Obj, v as Obj, depth + 1, walk)) delete target[k];
        continue;
      }
      const copy = copyValue(v, depth + 1, walk);
      if (copy === BAD) delete target[k];
      else define(target, k, copy);
    }
    return true;
  } finally {
    walk.path.delete(source);
  }
}

const BAD = Symbol('bad');

function copyValue(v: unknown, depth: number, walk: Walk): unknown {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : BAD;
  if (typeof v !== 'object') return BAD;

  let kind: 'date' | 'array' | 'plain' | 'other';
  try {
    kind = v instanceof Date ? 'date' : Array.isArray(v) ? 'array' : isPlainObject(v) ? 'plain' : 'other';
  } catch {
    return BAD;
  }
  if (kind === 'other') return BAD;
  if (kind === 'date') {
    let t: number;
    try {
      t = Date.prototype.getTime.call(v);
    } catch {
      return BAD;
    }
    return Number.isNaN(t) ? BAD : new Date(t).toISOString();
  }
  if (kind === 'plain') {
    const out: Obj = {};
    return mergeInto(out, v as Obj, depth, walk) ? out : BAD;
  }

  enter(v, depth, walk);
  try {
    const list = v as unknown[];
    let length: unknown;
    try {
      length = list.length;
    } catch {
      return BAD;
    }
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return BAD;
    spend(walk, length);
    const out: unknown[] = [];
    for (let i = 0; i < length; i++) {
      let item: unknown;
      try {
        if (!(i in list)) return BAD;
        item = list[i];
      } catch {
        return BAD;
      }
      // A list missing an element could widen a `nin`, so one bad element drops the whole list.
      const copy = item === undefined ? BAD : copyValue(item, depth + 1, walk);
      if (copy === BAD) return BAD;
      out.push(copy);
    }
    return out;
  } finally {
    walk.path.delete(v);
  }
}

function enter(v: object, depth: number, walk: Walk): void {
  if (depth > MAX_DEPTH) throw new AuthzConfigError(`scope attribute layer ${walk.layer} is nested deeper than ${MAX_DEPTH}`);
  if (walk.path.has(v)) throw new AuthzConfigError(`scope attribute layer ${walk.layer} holds a cycle`);
  walk.path.add(v);
}

function spend(walk: Walk, n: number): void {
  if (n > walk.left) throw new AuthzConfigError(`scope attributes hold more than ${MAX_VALUES} values`);
  walk.left -= n;
}

function isPlainObject(v: unknown): v is Obj {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isPlainSafe(v: unknown): boolean {
  try {
    return isPlainObject(v);
  } catch {
    return false;
  }
}

// defineProperty: never goes through an inherited setter.
function define(o: Obj, k: string, value: unknown): void {
  Object.defineProperty(o, k, { value, enumerable: true, writable: true, configurable: true });
}

// Only for the fresh objects built here: no cycles, no foreign values.
function deepFreeze<T>(v: T): T {
  if (v === null || typeof v !== 'object' || Object.isFrozen(v)) return v;
  for (const x of Object.values(v as object)) deepFreeze(x);
  return Object.freeze(v);
}
