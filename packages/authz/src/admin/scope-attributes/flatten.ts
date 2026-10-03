import { AuthzAdminFailure } from '../../contracts/admin.js';
import { AuthzConfigError } from '../../contracts/errors.js';
import type { ScopeAttributeLeaf } from '../ports.js';

/**
 * Column sizes of authz_scope_attribute (design §9.1), and the shape one node may have. The engine's
 * mergeAttributes refuses objects nested deeper than 32 (the root object counts as 1) and layers of more than
 * 10 000 keys (nested objects included), so a node stays at 31 path segments and 5000 keys, which leaves room
 * for the schema defaults; 1000 leaves keep a node to a handful of SQL statements.
 */
export const SCOPE_ATTRIBUTE_LIMITS = Object.freeze({ scopeType: 64, scopeId: 64, path: 160, json: 1024, depth: 31, leaves: 1000, keys: 5000 });

/** The keys of the nested object rows form, nested objects included: the distinct prefixes of the paths. */
export function attributeKeyCount(paths: Iterable<string>): number {
  const prefixes = new Set<string>();
  for (const path of paths) {
    let at = path.indexOf('.');
    while (at !== -1) {
      prefixes.add(path.slice(0, at));
      at = path.indexOf('.', at + 1);
    }
    prefixes.add(path);
  }
  return prefixes.size;
}

export type ScopeAttributeRows = Readonly<Record<string, ScopeAttributeLeaf>>;

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

const isLeaf = (v: unknown): v is ScopeAttributeLeaf => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));

// defineProperty: an own '__proto__' key must never reach a prototype setter.
const define = (o: Record<string, unknown>, k: string, value: unknown): void => {
  Object.defineProperty(o, k, { value, enumerable: true, writable: true, configurable: true });
};

/** Why `key` cannot be a path segment, or undefined. */
function badKey(key: string): string | undefined {
  if (key === '') return 'an empty key';
  if (key.includes('.')) return `key ${JSON.stringify(key)} contains '.'`;
  if (UNSAFE_KEYS.has(key)) return `key ${JSON.stringify(key)} is reserved`;
  return undefined;
}

/**
 * The leaf paths of a nested attribute object: `{ a: { b: 1 } }` ⇒ set `{ 'a.b': 1 }`. With `nulls`, a
 * null marks a path to remove (with everything below it) instead of being refused. Anything the table
 * cannot hold is an AuthzAdminFailure('invalid_attributes') whose field is the offending path, or `field`
 * for the root.
 */
export function flattenAttributes(value: unknown, opts: { readonly nulls?: boolean; readonly field?: string } = {}): { set: Record<string, ScopeAttributeLeaf>; remove: string[] } {
  const field = opts.field ?? 'attributes';
  const fail = (path: string, why: string): never => {
    throw new AuthzAdminFailure('invalid_attributes', `${path === '' ? field : `attribute ${path}`}: ${why}`, path === '' ? field : path);
  };
  if (!isPlainObject(value)) return fail('', 'must be a plain object');

  const set: Record<string, ScopeAttributeLeaf> = Object.create(null);
  const remove: string[] = [];
  let count = 0;
  const walk = (obj: Record<string, unknown>, prefix: string, depth: number): void => {
    for (const key of Object.keys(obj)) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      const why = badKey(key);
      if (why) fail(path, why);
      if (path.length > SCOPE_ATTRIBUTE_LIMITS.path) fail(path, `paths are at most ${SCOPE_ATTRIBUTE_LIMITS.path} characters`);
      if (depth > SCOPE_ATTRIBUTE_LIMITS.depth) fail(path, `paths are at most ${SCOPE_ATTRIBUTE_LIMITS.depth} keys deep`);
      if (++count > SCOPE_ATTRIBUTE_LIMITS.keys) fail('', `holds more than ${SCOPE_ATTRIBUTE_LIMITS.keys} keys (nested objects included)`);
      const v = obj[key];
      if (isPlainObject(v)) {
        walk(v, path, depth + 1);
        continue;
      }
      if (v === null && opts.nulls) {
        remove.push(path);
        continue;
      }
      if (!isLeaf(v)) fail(path, 'a value must be a string, a finite number, a boolean or a nested object');
      if (JSON.stringify(v).length > SCOPE_ATTRIBUTE_LIMITS.json) fail(path, `a value is at most ${SCOPE_ATTRIBUTE_LIMITS.json} characters as JSON`);
      set[path] = v as ScopeAttributeLeaf;
    }
  };
  walk(value, '', 1);
  return { set: { ...set }, remove };
}

/** The nested object of flat rows; rows that cannot form one (a leaf with a path below it, a bad key) are an AuthzConfigError. */
export function unflattenAttributes(rows: ScopeAttributeRows): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const path of Object.keys(rows).sort()) {
    const value = rows[path];
    if (!isLeaf(value)) throw new AuthzConfigError(`scope attribute row ${JSON.stringify(path)} holds ${JSON.stringify(value)}, not a scalar`);
    const keys = path.split('.');
    let cur = out;
    for (const [i, key] of keys.entries()) {
      const why = badKey(key);
      if (why) throw new AuthzConfigError(`scope attribute row ${JSON.stringify(path)}: ${why}`);
      if (i === keys.length - 1) {
        if (Object.hasOwn(cur, key)) throw new AuthzConfigError(`scope attribute row ${JSON.stringify(path)} conflicts with a row below it`);
        define(cur, key, value);
        break;
      }
      if (!Object.hasOwn(cur, key)) define(cur, key, {});
      const next = cur[key];
      if (!isPlainObject(next)) throw new AuthzConfigError(`scope attribute row ${JSON.stringify(path)} lies below the scalar row ${JSON.stringify(keys.slice(0, i + 1).join('.'))}`);
      cur = next;
    }
  }
  return out;
}

/** Whether `path` is `prefix` or lies below it. */
export const underPath = (path: string, prefix: string): boolean => path === prefix || path.startsWith(`${prefix}.`);

/** The scalar a `value_json` column holds; anything else is an AuthzConfigError. */
export function parseAttributeLeaf(json: string, where: string): ScopeAttributeLeaf {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch (e) {
    throw new AuthzConfigError(`${where}: value_json is not JSON`, { cause: e });
  }
  if (!isLeaf(v)) throw new AuthzConfigError(`${where}: value_json holds ${json}, not a scalar`);
  return v;
}
