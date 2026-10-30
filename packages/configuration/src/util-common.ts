/* eslint-disable @typescript-eslint/no-unsafe-return */
import { ConfigVar } from '@spinajs/configuration-common';
import _ from 'lodash';

/**
 * Platform-free configuration merge/pick helpers. Split out of util.ts so the
 * browser entry can use them without pulling in fs / path / process.
 */

export function merge(to: unknown, from: unknown): unknown {
  _.mergeWith(to, from, (src, dest) => {
    if (_.isArray(src) && _.isArray(dest)) {
      const tmp = src.concat(dest);
      return _.uniqWith(tmp, _.isEqual);
    } else if (!src) {
      return dest;
    }
  });

  return to;
}

export function mergeArrays(target: unknown[], source: unknown[]): unknown {
  if (_.isArray(target)) {
    return target.concat(source);
  }
}

/**
 * Config arrays that every merge adds to, because several packages and the app each contribute entries to them.
 * Any other array is a value: a later source replaces it. `*` matches one key.
 */
export const COMPOSED_CONFIG_ARRAYS: readonly string[] = [
  'system.dirs.*',
  'fs.providers',
  'queue.connections',
  'http.Static',
  'logger.filters',
  'authz.rbac.roles.*.*',
  'authz.rbac.serviceRoles.*',
  'authz.abac.policies',
  'authz.admin.guard.keepHolders',
  'authz.fields.neverRead',
  'validation.strict.idPrefixes',
  '*.__file__',
];

const COMPOSED_PATTERNS = COMPOSED_CONFIG_ARRAYS.map((p) => p.split('.'));

/**
 * `concat`: every array concatenates, as package config files merge among themselves.
 * `replace`: an array replaces the one already there, unless its path is in `COMPOSED_CONFIG_ARRAYS`.
 */
export type ArrayMerge = 'concat' | 'replace';

// The lodash customizer gets no path, only the parent object of the source value: mark the composed keys by parent.
function composedKeysOf(source: unknown): WeakMap<object, Set<string>> {
  const found = new WeakMap<object, Set<string>>();

  const visit = (node: unknown, path: string[]) => {
    if (!_.isPlainObject(node)) return;
    const obj = node as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const at = [...path, key];
      const matching = COMPOSED_PATTERNS.filter((p) => p.length >= at.length && at.every((s, i) => p[i] === '*' || p[i] === s));
      if (matching.some((p) => p.length === at.length)) {
        const keys = found.get(obj) ?? new Set<string>();
        keys.add(key);
        found.set(obj, keys);
      }
      if (matching.some((p) => p.length > at.length)) visit(obj[key], at);
    }
  };

  visit(source, []);
  return found;
}

/** Deep-merges `source` into `target` in place, like `_.merge`, with the array rule of `arrays`. */
export function mergeConfig<T>(target: T, source: unknown, arrays: ArrayMerge): T {
  const composed = arrays === 'replace' ? composedKeysOf(source) : undefined;

  const customizer = (value: unknown, srcValue: unknown, key: string, _object: unknown, srcParent: object): unknown => {
    if (!Array.isArray(value)) return undefined;
    if (!composed || composed.get(srcParent)?.has(key)) return value.concat(srcValue);
    // Merged into a fresh array, as lodash copies an array into a key that holds none.
    return Array.isArray(srcValue) ? _.mergeWith([], srcValue, customizer) : undefined;
  };

  return _.mergeWith(target, source, customizer);
}

/** What `Configuration.merge()` does at the stored value: arrays concatenate, also an array stored at the path itself. */
export function mergeInto(stored: unknown, value: unknown): void {
  if (Array.isArray(stored)) {
    stored.push(...(Array.isArray(value) ? value : [value]));
  } else {
    _.mergeWith(stored, value, mergeArrays);
  }
}

export function pickString(obj: { [key: string]: any }): [string, string][] {
  return Object.keys(obj)
    .filter((k) => typeof obj[k] === 'string')
    .map((k) => {
      return [k, obj[k]];
    });
}

export function pickObjects(obj: { [key: string]: any }): [string, any][] {
  return Object.keys(obj)
    .filter((k) => (typeof obj[k] === 'object' || Array.isArray(obj[k])) && obj[k] !== null)
    .map((k) => {
      return [k, obj[k]];
    });
}

/**
 * recursively maps object values
 *
 * @param obj
 * @param fn
 * @returns
 */
export function mapObject(obj: any, fn: (obj: any) => any) {
  if (!_.isPlainObject(obj)) return obj;
  return Object.keys(obj).reduce((acc: any, key: string) => {
    const value = obj[key];
    if (Array.isArray(value)) {
      // only descend into plain objects - class instances (eg. luxon DateTime)
      // must be passed through untouched or they lose their prototype/methods
      acc[key] = value.map((x) => (_.isPlainObject(x) ? fn(mapObject(x, fn)) : x));
    } else if (_.isPlainObject(value) && !(value instanceof ConfigVar)) {
      acc[key] = fn(mapObject(value, fn));
    } else {
      acc[key] = value;
    }
    return acc;
  }, {});
}
